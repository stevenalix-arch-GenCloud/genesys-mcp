// MCP tool definitions + dispatch. Each tool maps to one or two Genesys Cloud
// Platform API calls and returns plain JSON for the model.
//
// Scope is deliberate: configuration reads, create/build actions, and
// read-only Quality Management evaluation and customer survey analytics.
// Outbound campaigns and sequences are always created OFF, and no ignition
// tool ships: a human presses go.


import { GenesysClient, GenesysError, REGIONS, pathId } from './genesys.js';
import { ABOUT } from './about.js';
import { validateFlowSpec, specToArchyYaml, specToMermaid, configToMermaid, FLOW_ACTIONS } from './flows.js';
import { composeAttemptLimits, composeCallableTimeSet, composeContactList, cadenceToMermaid, DIALING_MODES } from './outbound.js';
import { AVA_TOOLS, AVA_WRITE_TOOLS, AVA_TOOL_GROUP } from './ava-tools.js';
import { refusalFor, redactSecrets, redactNamedValues, redactArchyYaml } from './rules.js';

// ---------- name → object resolution helpers ----------

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveOne(gc, kind, path, ref, query = {}) {
  if (GUID_RE.test(ref)) return { id: ref };
  const { entities } = await gc.listAll(path, { ...query, name: ref }, { max: 50 });
  let matches = entities.filter((e) => e.name?.toLowerCase() === ref.toLowerCase());
  if (!matches.length) {
    const { entities: wide } = await gc.listAll(path, { ...query, name: `*${ref}*` }, { max: 50 });
    matches = wide;
  }
  if (!matches.length) throw new GenesysError(`No ${kind} found matching "${ref}"`, 404);
  if (matches.length > 1) {
    throw new GenesysError(
      `Ambiguous ${kind} "${ref}" - matches: ${matches.map((m) => m.name).join(', ')}. Use the exact name or id.`, 409);
  }
  return matches[0];
}

async function resolveUser(gc, ref) {
  if (GUID_RE.test(ref)) return { id: ref };
  const res = await gc.post('/api/v2/users/search', {
    query: [{ fields: ['email', 'name'], value: ref, type: 'CONTAINS' }],
    pageSize: 25,
  });
  const results = res.results || [];
  const exact = results.filter((u) => u.email?.toLowerCase() === ref.toLowerCase() || u.name?.toLowerCase() === ref.toLowerCase());
  const matches = exact.length ? exact : results;
  if (!matches.length) throw new GenesysError(`No user found matching "${ref}"`, 404);
  if (matches.length > 1) {
    throw new GenesysError(
      `Ambiguous user "${ref}" - matches: ${matches.map((u) => `${u.name} <${u.email}>`).join(', ')}. Use the email or id.`, 409);
  }
  return matches[0];
}

const slim = (e) => ({ id: e.id, name: e.name, ...(e.email ? { email: e.email } : {}), ...(e.state && e.state !== 'active' ? { state: e.state } : {}) });

function conversationIdFromInput(value) {
  const input = String(value || '').trim();

  if (GUID_RE.test(input)) {
    return input;
  }

  const match = input.match(
    /\/analytics\/interactions\/([0-9a-f-]{36})(?:\/|$)/i
  );

  if (match && GUID_RE.test(match[1])) {
    return match[1];
  }

  throw new GenesysError(
    'Provide a valid Genesys Cloud conversation ID or interaction URL.',
    400
  );
}

// ---------- tools ----------

export const TOOLS = [
  {
    name: 'about',
    description: 'Who operates this server, why it exists, and the ground rules. Call this when you need context about the operator or how to behave.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    genesys: false,
    handler: () => ABOUT,
  },
  {
    name: 'check_connection',
    description: 'Verify that the Worker can authenticate to Genesys Cloud. Returns the org name, region, and object counts (queues, users, flows). Run this first if other tools are failing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (gc) => {
      const org = await gc.get('/api/v2/organizations/me');
      const [queues, users, flows] = await Promise.all([
        gc.get('/api/v2/routing/queues', { pageSize: 1 }),
        gc.get('/api/v2/users', { pageSize: 1, state: 'any' }),
        gc.get('/api/v2/flows', { pageSize: 1 }),
      ]);
      return {
        ok: true, org: org.name, orgId: org.id, region: gc.region,
        counts: { queues: queues.total, users: users.total, flows: flows.total },
      };
    },
  },
    // ----- mock data actions -----

{
  name: 'create_mock_data_action',

  description:
    'TEST AND DEMO ONLY. Create a MOCK Genesys Cloud Data Action that returns ' +
    'simulated data without calling a real production backend system. ' +
    'Use this only for AVA testing, demonstrations, placeholders, and controlled test scenarios. ' +
    'The tool targets an explicitly supplied integration ID or resolves one exact active integration by name. ' +
    'DO NOT use this tool when the user wants a production Data Action connected to a real API. ' +
    'For a real backend integration, use create_data_action instead.',

  inputSchema: {
    type: 'object',

    properties: {
      name: {
        type: 'string',
        description:
          'Name for the mock Data Action, such as "Mock - Look Up Appointment".',
      },

      category: {
        type: 'string',
        description:
          'Category used to organize the mock Data Action. ' +
          'Defaults to "AVA Mock Data Actions".',
      },

      integration_id: {
        type: 'string',
        description:
          'Optional Genesys Cloud integration ID. When omitted, the tool searches ' +
          'for one exact enabled integration matching integration_name.',
      },

      integration_name: {
        type: 'string',
        description:
          'Exact name of the Genesys Cloud integration to use. ' +
          'Defaults to "Mock Data Actions - Salix".',
      },

      input_contract: {
        type: 'object',
        description:
          'JSON Schema describing the inputs accepted by the mock Data Action.',
        additionalProperties: true,
      },

      output_contract: {
        type: 'object',
        description:
          'JSON Schema describing the response returned by the mock Data Action.',
        additionalProperties: true,
      },

      mock_response: {
        type: 'object',
        description:
          'The fixed JSON object returned by the mock Data Action during AVA testing.',
        additionalProperties: true,
      },
    },

    required: [
      'name',
      'input_contract',
      'output_contract',
      'mock_response',
    ],

    additionalProperties: false,
  },

  handler: async (gc, a) => {
    const name = String(a.name || '').trim();

    if (!name) {
      throw new GenesysError(
        'name is required.',
        400,
      );
    }

    const category =
      String(a.category || '').trim() ||
      'AVA Mock Data Actions';

    const requestedIntegrationId =
      String(a.integration_id || '').trim();

    const requestedIntegrationName =
      String(a.integration_name || '').trim() ||
      'Mock Data Actions - Salix';

    if (
      !a.input_contract ||
      typeof a.input_contract !== 'object' ||
      Array.isArray(a.input_contract)
    ) {
      throw new GenesysError(
        'input_contract must be a JSON Schema object.',
        400,
      );
    }

    if (
      !a.output_contract ||
      typeof a.output_contract !== 'object' ||
      Array.isArray(a.output_contract)
    ) {
      throw new GenesysError(
        'output_contract must be a JSON Schema object.',
        400,
      );
    }

    if (
      !a.mock_response ||
      typeof a.mock_response !== 'object' ||
      Array.isArray(a.mock_response)
    ) {
      throw new GenesysError(
        'mock_response must be a JSON object.',
        400,
      );
    }

    /*
     * Resolve the integration deterministically.
     *
     * Order:
     * 1. Use integration_id when explicitly supplied.
     * 2. Otherwise find one exact enabled integration by name.
     *
     * Never select the first generic Data Actions integration.
     */
    let integration;

    if (requestedIntegrationId) {
      if (!GUID_RE.test(requestedIntegrationId)) {
        throw new GenesysError(
          'integration_id must be a valid Genesys Cloud GUID.',
          400,
        );
      }

      integration = await gc.get(
        `/api/v2/integrations/${pathId(requestedIntegrationId)}`,
      );

      if (!integration?.id) {
        throw new GenesysError(
          `The integration "${requestedIntegrationId}" could not be retrieved.`,
          404,
        );
      }
    } else {
      const integrationsResponse = await gc.get(
        '/api/v2/integrations',
        {
          pageSize: 100,
        },
      );

      const integrations = Array.isArray(integrationsResponse?.entities)
        ? integrationsResponse.entities
        : [];

      const exactMatches = integrations.filter((candidate) => {
        const candidateName = String(candidate?.name || '')
          .trim()
          .toLowerCase();

        return (
          candidateName === requestedIntegrationName.toLowerCase() &&
          candidate?.enabled !== false
        );
      });

      if (!exactMatches.length) {
        throw new GenesysError(
          `No enabled Genesys Cloud integration was found with the exact name ` +
          `"${requestedIntegrationName}". Supply integration_id explicitly or ` +
          'verify that the integration exists and is enabled.',
          404,
        );
      }

      if (exactMatches.length > 1) {
        const matchingIds = exactMatches
          .map((candidate) => candidate.id)
          .filter(Boolean)
          .join(', ');

        throw new GenesysError(
          `More than one enabled integration is named ` +
          `"${requestedIntegrationName}". Supply integration_id explicitly. ` +
          `Matching IDs: ${matchingIds}`,
          409,
        );
      }

      integration = exactMatches[0];
    }

    if (integration.enabled === false) {
      throw new GenesysError(
        `Integration "${integration.name || integration.id}" is disabled.`,
        409,
      );
    }

    /*
     * This guards against accidentally selecting Salesforce, AWS Lambda,
     * a generic web services integration, or another unrelated integration.
     */
    const integrationType = String(
      integration?.integrationType?.id ||
      integration?.integrationType?.name ||
      integration?.type ||
      '',
    ).toLowerCase();

    if (
      integrationType &&
      !integrationType.includes('purecloud-data-actions')
    ) {
      throw new GenesysError(
        `Integration "${integration.name || integration.id}" has type ` +
        `"${integrationType}", not "purecloud-data-actions". ` +
        'Refusing to create the mock action on the wrong integration.',
        409,
      );
    }

    const mockResponseJson = JSON.stringify(a.mock_response);

    /*
     * Important:
     * integrationId is explicitly included in the creation payload.
     * This prevents Genesys or the tool from selecting a different
     * Data Actions integration.
     */
    const payload = {
      name,
      category,
      integrationId: integration.id,

      contract: {
        input: a.input_contract,
        output: a.output_contract,
      },

      config: {
        request: {
          requestUrlTemplate: 'https://example.invalid/ava-mock',
          requestType: 'POST',
          headers: {},
          requestTemplate: '${input.rawRequest}',
        },

        response: {
          translationMap: {
            mockResponse: mockResponseJson,
          },

          translationMapDefaults: {},

          successTemplate: '${mockResponse}',
        },
      },

      secure: false,
    };

    let createdAction;

    try {
      createdAction = await gc.post(
        '/api/v2/integrations/actions',
        payload,
      );
    } catch (error) {
      /*
       * Preserve the original Genesys details when the client exposes them.
       * Different GenesysClient implementations may place the API response
       * in different properties, so check the common locations.
       */
      const genesysDetails =
        error?.responseBody ||
        error?.body ||
        error?.details ||
        error?.response?.data ||
        error?.message ||
        error;

      let detailText;

      try {
        detailText =
          typeof genesysDetails === 'string'
            ? genesysDetails
            : JSON.stringify(genesysDetails);
      } catch {
        detailText = String(genesysDetails);
      }

      throw new GenesysError(
        `Genesys Cloud rejected creation of mock Data Action "${name}" ` +
        `on integration "${integration.name || integration.id}" ` +
        `(${integration.id}). Details: ${detailText}`,
        error?.status ||
          error?.statusCode ||
          error?.response?.status ||
          400,
      );
    }

    return {
      created: true,
      testOnly: true,

      action: {
        id: createdAction?.id || null,
        name: createdAction?.name || name,
        category: createdAction?.category || category,
      },

      integration: {
        id: integration.id,
        name: integration.name || requestedIntegrationName,
        type: integrationType || null,
        enabled: integration.enabled !== false,
      },

      mockResponse: a.mock_response,

      message:
        `Created test-only mock Data Action "${name}" on ` +
        `"${integration.name || integration.id}".`,
    };
  },
},
       
   {
    name: 'replace_mock_responses',
    description:
  'TEST AND DEMO ONLY. Change the simulated response returned by an existing MOCK Data Action created for AVA testing. ' +
  'Use this to simulate conditions such as success, not found, multiple results, or errors. ' +
  'DO NOT use this tool to modify a real production Data Action or a Data Action connected to a real backend.',

    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            'Existing mock Data Action name or Genesys Cloud action ID.',
        },
        mock_response: {
          type: 'object',
          description:
            'The new JSON object the mock Data Action should return during AVA testing.',
          additionalProperties: true,
        },
      },

      required: [
        'action',
        'mock_response',
      ],

      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const actionRef = String(a.action || '').trim();

      if (!actionRef) {
        throw new GenesysError(
          'action is required.',
          400
        );
      }

      if (
        !a.mock_response ||
        typeof a.mock_response !== 'object' ||
        Array.isArray(a.mock_response)
      ) {
        throw new GenesysError(
          'mock_response must be a JSON object.',
          400
        );
      }

      let existingAction;

      if (GUID_RE.test(actionRef)) {
        existingAction = await gc.get(
          `/api/v2/integrations/actions/${pathId(actionRef)}`
        );
      } else {
        const actions = await gc.listAll(
          '/api/v2/integrations/actions',
          {},
          { max: 500 }
        );

        const exactMatches = actions.entities.filter(
          (action) =>
            action.name?.toLowerCase() ===
            actionRef.toLowerCase()
        );

        if (!exactMatches.length) {
          throw new GenesysError(
            `No Data Action found matching "${actionRef}".`,
            404
          );
        }

        if (exactMatches.length > 1) {
          throw new GenesysError(
            `More than one Data Action is named "${actionRef}". Use the action ID instead.`,
            409
          );
        }

        existingAction = exactMatches[0];

        /*
         * listAll may return only the list representation.
         * Retrieve the complete action before updating it.
         */
        existingAction = await gc.get(
          `/api/v2/integrations/actions/${pathId(existingAction.id)}`
        );
      }

      if (!existingAction?.id) {
        throw new GenesysError(
          'The existing Data Action could not be loaded.',
          404
        );
      }

      const existingConfig = existingAction.config || {};
      const existingRequest = existingConfig.request || {};
      const existingResponse = existingConfig.response || {};
      const existingTranslationMap =
        existingResponse.translationMap || {};

      /*
       * Safety check: only update actions created using our
       * mock-response convention.
       */
      if (
        !Object.prototype.hasOwnProperty.call(
          existingTranslationMap,
          'mockResponse'
        )
      ) {
        throw new GenesysError(
          `Data Action "${existingAction.name || existingAction.id}" does not appear to be a mock Data Action created by this MCP. No changes were made.`,
          400
        );
      }

      const updatedAction = {
        ...existingAction,

        config: {
          ...existingConfig,

          request: {
            ...existingRequest,
          },

          response: {
            ...existingResponse,

            translationMap: {
              ...existingTranslationMap,
              mockResponse:
                JSON.stringify(a.mock_response),
            },
          },
        },
      };

      /*
       * Remove read-only metadata that should not be sent
       * back in the update payload.
       */
      delete updatedAction.id;
      delete updatedAction.selfUri;
      delete updatedAction.version;
      delete updatedAction.modifiedBy;
      delete updatedAction.modifiedDate;
      delete updatedAction.dateModified;

      const saved = await gc.put(
        `/api/v2/integrations/actions/${pathId(existingAction.id)}`,
        updatedAction
      );

      return {
        updated: true,

        action: {
          id: saved.id || existingAction.id,
          name: saved.name || existingAction.name,
          category:
            saved.category ||
            existingAction.category,
          integrationId:
            saved.integrationId ||
            existingAction.integrationId,
        },

        mockResponse: a.mock_response,

        note:
          'The mock response was replaced. The next AVA test using this Data Action will use the new configured mock response.',
      };
    },
  }, 
  // ----- quality management -----
   {
    name: 'create_quality_evaluation_form',
    description: 'Create an unpublished draft Genesys Cloud Quality Management evaluation form with question groups, weighted questions, scored answer options, N/A settings, help text, required comments, critical questions, and fatal questions. AI scoring is not configured by this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Name of the evaluation form',
        },
        question_groups: {
          type: 'array',
          description:
            'Question groups containing names, optional settings, and questions',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
      required: [
        'name',
        'question_groups',
      ],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const formName = String(
        a.name || ''
      ).trim();

      if (!formName) {
        throw new GenesysError(
          'name is required.',
          400
        );
      }

      if (
        !Array.isArray(
          a.question_groups
        ) ||
        !a.question_groups.length
      ) {
        throw new GenesysError(
          'question_groups must contain at least one question group.',
          400
        );
      }

      const questionGroups =
        a.question_groups.map(
          (group, groupIndex) => {
            const groupName = String(
              group?.name || ''
            ).trim();

            if (!groupName) {
              throw new GenesysError(
                `Question group ${groupIndex + 1} must have a name.`,
                400
              );
            }

            if (
              !Array.isArray(
                group.questions
              ) ||
              !group.questions.length
            ) {
              throw new GenesysError(
                `Question group "${groupName}" must contain at least one question.`,
                400
              );
            }

            const groupWeight =
              group.weight === undefined
                ? 1
                : Number(
                    group.weight
                  );

            if (
              !Number.isFinite(
                groupWeight
              ) ||
              groupWeight < 0
            ) {
              throw new GenesysError(
                `Question group "${groupName}" weight must be a non-negative number.`,
                400
              );
            }

            const questions =
              group.questions.map(
                (
                  question,
                  questionIndex
                ) => {
                  const questionText =
                    String(
                      question?.text || ''
                    ).trim();

                  if (!questionText) {
                    throw new GenesysError(
                      `Question ${questionIndex + 1} in group "${groupName}" must have text.`,
                      400
                    );
                  }

                  /*
                   * Accept friendly MCP values and native
                   * Genesys QuestionType values.
                   */
                  const requestedQuestionType =
                    question.type ||
                    'multipleChoice';

                  const questionTypeMap = {
                    multipleChoice:
                      'multipleChoiceQuestion',
                    multipleChoiceQuestion:
                      'multipleChoiceQuestion',

                    multipleSelect:
                      'multipleSelectQuestion',
                    multipleSelectQuestion:
                      'multipleSelectQuestion',
                  };

                  const questionType =
                    questionTypeMap[
                      requestedQuestionType
                    ];

                  if (!questionType) {
                    throw new GenesysError(
                      `Question "${questionText}" has unsupported type "${requestedQuestionType}". ` +
                      'Use multipleChoice, multipleChoiceQuestion, multipleSelect, or multipleSelectQuestion.',
                      400
                    );
                  }

                  if (
                    !Array.isArray(
                      question.answer_options
                    ) ||
                    question
                      .answer_options
                      .length < 2
                  ) {
                    throw new GenesysError(
                      `Question "${questionText}" must contain at least two answer options.`,
                      400
                    );
                  }

                  const answerOptions =
                    question
                      .answer_options
                      .map(
                        (
                          answer,
                          answerIndex
                        ) => {
                          const answerText =
                            String(
                              answer?.text ||
                                ''
                            ).trim();

                          if (
                            !answerText
                          ) {
                            throw new GenesysError(
                              `Answer ${answerIndex + 1} for "${questionText}" must have text.`,
                              400
                            );
                          }

                          const answerValue =
                            Number(
                              answer.value
                            );

                          if (
                            !Number.isFinite(
                              answerValue
                            )
                          ) {
                            throw new GenesysError(
                              `Answer "${answerText}" for "${questionText}" must have a numeric value.`,
                              400
                            );
                          }

                          return {
                            text:
                              answerText,
                            value:
                              answerValue,
                          };
                        }
                      );

                  const questionBody = {
                    text:
                      questionText,
                    type:
                      questionType,
                    naEnabled:
                      question.na_enabled ===
                      true,
                    commentsRequired:
                      question.comments_required ===
                      true,
                    isCritical:
                      question.is_critical ===
                      true,
                    isKill:
                      question.is_kill ===
                      true,
                    answerOptions,
                  };

                  if (
                    question.help_text !==
                    undefined
                  ) {
                    const helpText =
                      String(
                        question.help_text
                      ).trim();

                    if (helpText) {
                      questionBody.helpText =
                        helpText;
                    }
                  }

                  if (
                    question.weight !==
                    undefined
                  ) {
                    const questionWeight =
                      Number(
                        question.weight
                      );

                    if (
                      !Number.isFinite(
                        questionWeight
                      ) ||
                      questionWeight < 0
                    ) {
                      throw new GenesysError(
                        `Question "${questionText}" weight must be a non-negative number.`,
                        400
                      );
                    }

                    questionBody.weight =
                      questionWeight;
                  }

                  return questionBody;
                }
              );

            /*
             * Genesys requires the QuestionGroup
             * subtype discriminator.
             */
            return {
              type:
                'questionGroup',
              name:
                groupName,
              weight:
                groupWeight,
              manualWeight:
                group.manual_weight !==
                false,
              naEnabled:
                group.na_enabled ===
                true,
              defaultAnswersToHighest:
                group
                  .default_answers_to_highest ===
                true,
              defaultAnswersToNA:
                group
                  .default_answers_to_na ===
                true,
              questions,
            };
          }
        );

      const body = {
        name:
          formName,
        questionGroups,
      };

      const createdForm =
        await gc.post(
          '/api/v2/quality/forms/evaluations',
          body
        );

      return {
        created:
          true,
        published:
          false,
        aiScoringConfigured:
          false,
        formId:
          createdForm.id || null,
        name:
          createdForm.name ||
          formName,
        questionGroupCount:
          questionGroups.length,
        questionCount:
          questionGroups.reduce(
            (
              total,
              group
            ) =>
              total +
              group.questions.length,
            0
          ),
        form:
          createdForm,
        note:
          'The evaluation form was created as an unpublished draft. AI scoring was not configured and must be enabled in the Genesys Cloud evaluation-form editor.',
      };
    },
  },
  {
    name: 'list_quality_evaluations',
    description: 'List completed Genesys Cloud Quality Management evaluations for a specified date range.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        end_date: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
      },
      required: ['start_date', 'end_date'],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
  const interval = `${a.start_date}T00:00:00.000Z/${a.end_date}T23:59:59.999Z`;

  const result = await gc.post(
    '/api/v2/analytics/evaluations/aggregates/query',
    {
      interval,
      groupBy: [
        'conversationId',
        'evaluationId',
        'formId',
        'userId'
      ],
      metrics: [
        'nEvaluations',
        'oTotalScore'
      ]
    }
  );

  return {
  startDate: a.start_date,
  endDate: a.end_date,
  results: result.results || [],
};
},
    },

    {
    name: 'get_quality_evaluation',
    description: 'Get one completed Genesys Cloud Quality Management evaluation, including its question groups, questions, answers, and scores.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Genesys Cloud conversation ID',
        },
        evaluation_id: {
          type: 'string',
          description: 'Genesys Cloud quality evaluation ID',
        },
      },
      required: ['conversation_id', 'evaluation_id'],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const conversationId = pathId(
        'conversation id',
        a.conversation_id
      );

      const evaluationId = pathId(
        'evaluation id',
        a.evaluation_id
      );

     const evaluation = await gc.get(
  `/api/v2/quality/conversations/${conversationId}/evaluations/${evaluationId}`
);

return {
  conversationId,
  evaluationId,
  evaluation,
  };
    },
  },

    {
    name: 'get_quality_conversation',
    description: 'Get the Genesys Cloud conversation details associated with a Quality Management evaluation. Used to retrieve participants, agent information, ANI, and DNIS.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Genesys Cloud conversation ID',
        },
      },
      required: ['conversation_id'],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const conversationId = pathId(
        'conversation id',
        a.conversation_id
      );

      return gc.get(
        `/api/v2/analytics/conversations/${conversationId}/details`
      );
    },
  },
  {
    name: 'get_quality_evaluation_form',
    description: 'Get a published Genesys Cloud Quality Management evaluation form by form ID, including question groups, individual questions, answer options, weights, and scoring configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        form_id: {
          type: 'string',
          description: 'Genesys Cloud published Quality Management evaluation form ID',
        },
      },
      required: ['form_id'],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const formId = pathId(
        'form id',
        a.form_id
      );

      const form = await gc.get(
        `/api/v2/quality/publishedforms/evaluations/${formId}`
      );

      return {
        formId,
        form,
      };
    },
  },
    {
    name: 'get_quality_question_scores',
    description: 'Get the individual question, answer, and scoring data from one completed Genesys Cloud Quality Management evaluation.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Genesys Cloud conversation ID',
        },
        evaluation_id: {
          type: 'string',
          description: 'Genesys Cloud quality evaluation ID',
        },
      },
      required: ['conversation_id', 'evaluation_id'],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const conversationId = pathId(
        'conversation id',
        a.conversation_id
      );

      const evaluationId = pathId(
        'evaluation id',
        a.evaluation_id
      );

      const evaluation = await gc.get(
        `/api/v2/quality/conversations/${conversationId}/evaluations/${evaluationId}`
      );

      return {
        conversationId,
        evaluationId,
        evaluationForm: evaluation.evaluationForm || null,
        answers: evaluation.answers || null,
      };
    },
  },

  // ----- customer surveys -----
   {
  name: 'create_customer_survey_form',
  description:
    'Create a draft Genesys Cloud customer survey form with any number of question groups and questions. Supports multiple-choice, NPS, and free-text questions, including answer options, help text, explanation prompts, N/A settings, and conditional visibility.',

  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the customer survey form.',
      },

      language: {
        type: 'string',
        description:
          'Survey language such as en-US. Defaults to en-US.',
      },

      header: {
        type: 'string',
        description:
          'Optional introductory text displayed at the beginning of the survey.',
      },

      footer: {
        type: 'string',
        description:
          'Optional closing text displayed at the end of the survey.',
      },

      question_groups: {
        type: 'array',
        description:
          'One or more question groups containing the survey questions.',
        items: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },

    required: [
      'name',
      'question_groups'
    ],

    additionalProperties: false,
  },

 handler: async (gc, a) => {
  const name = String(a.name || '').trim();
  const language = String(a.language || 'en-US').trim();

  if (!name) {
    throw new GenesysError(
      'Survey form name is required.',
      400
    );
  }

  if (!Array.isArray(a.question_groups) || !a.question_groups.length) {
    throw new GenesysError(
      'question_groups must contain at least one question group.',
      400
    );
  }

  const supportedTypes = new Set([
    'multipleChoiceQuestion',
    'freeTextQuestion',
    'npsQuestion',
  ]);

  let questionCount = 0;

  const questionGroups = a.question_groups.map(
    (group, groupIndex) => {
      const groupName = String(
        group?.name || `Question Group ${groupIndex + 1}`
      ).trim();

      if (!Array.isArray(group?.questions) || !group.questions.length) {
        throw new GenesysError(
          `Question group "${groupName}" must contain at least one question.`,
          400
        );
      }

      const questions = group.questions.map(
        (question, questionIndex) => {
          const location =
            `Question ${questionIndex + 1} in "${groupName}"`;

          const text = String(
            question?.text || ''
          ).trim();

          const type = String(
            question?.type || ''
          ).trim();

          if (!text) {
            throw new GenesysError(
              `${location} is missing question text.`,
              400
            );
          }

          if (!supportedTypes.has(type)) {
            throw new GenesysError(
              `${location} has unsupported type "${type}". ` +
              'Supported types are multipleChoiceQuestion, freeTextQuestion, and npsQuestion.',
              400
            );
          }

          const result = {
            text,
            type,
            helpText:
              question.help_text !== undefined
                ? String(question.help_text)
                : '',
            explanationPrompt:
              question.explanation_prompt !== undefined
                ? String(question.explanation_prompt)
                : '',
            naEnabled:
              question.na_enabled === true,
          };

          if (type === 'multipleChoiceQuestion') {
            if (
              !Array.isArray(question.answer_options) ||
              question.answer_options.length < 2
            ) {
              throw new GenesysError(
                `${location} is multiple choice and must contain at least two answer_options.`,
                400
              );
            }

            result.answerOptions =
              question.answer_options.map(
                (option, optionIndex) => {
                  const optionText = String(
                    option?.text || ''
                  ).trim();

                  if (!optionText) {
                    throw new GenesysError(
                      `${location}, answer option ${optionIndex + 1} is missing text.`,
                      400
                    );
                  }

                  const value = Number(option.value);

                  if (!Number.isFinite(value)) {
                    throw new GenesysError(
                      `${location}, answer option ${optionIndex + 1} must contain a numeric value.`,
                      400
                    );
                  }

                  return {
                    text: optionText,
                    value,
                  };
                }
              );
          }

          if (type === 'freeTextQuestion') {
            const maxCharacters =
              question.max_response_characters === undefined
                ? 500
                : Math.floor(
                    Number(
                      question.max_response_characters
                    )
                  );

            if (
              !Number.isFinite(maxCharacters) ||
              maxCharacters < 1 ||
              maxCharacters > 10000
            ) {
              throw new GenesysError(
                `${location} max_response_characters must be between 1 and 10000.`,
                400
              );
            }

            result.maxResponseCharacters =
              maxCharacters;
          }

          if (question.visibility_condition) {
            result.visibilityCondition =
              question.visibility_condition;
          }

          if (
            question.additional_properties &&
            typeof question.additional_properties === 'object' &&
            !Array.isArray(question.additional_properties)
          ) {
            Object.assign(
              result,
              question.additional_properties
            );
          }

          questionCount++;

          return result;
        }
      );

      const result = {
        name: groupName,
        naEnabled:
          group.na_enabled === true,
        questions,
      };

      if (group.visibility_condition) {
        result.visibilityCondition =
          group.visibility_condition;
      }

      if (
        group.additional_properties &&
        typeof group.additional_properties === 'object' &&
        !Array.isArray(group.additional_properties)
      ) {
        Object.assign(
          result,
          group.additional_properties
        );
      }

      return result;
    }
  );

  const body = {
    name,
    language,
    header:
      a.header !== undefined
        ? String(a.header)
        : '',
    footer:
      a.footer !== undefined
        ? String(a.footer)
        : '',
    questionGroups,
  };

  const created = await gc.post(
    '/api/v2/quality/forms/surveys',
    body
  );

  return {
    created: true,
    published: false,
    formId: created.id || null,
    contextId: created.contextId || null,
    name: created.name || name,
    language: created.language || language,
    questionGroupCount: questionGroups.length,
    questionCount,
    form: created,
    note:
      'Survey form created as a draft. It has not been published or attached to a survey policy.',
  };
},
}, 
  {
    name: 'list_quality_surveys',
    description: 'List Genesys Cloud Quality Management survey results for a specified date range.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        end_date: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
      },
      required: ['start_date', 'end_date'],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const interval = `${a.start_date}T00:00:00.000Z/${a.end_date}T23:59:59.999Z`;

      const result = await gc.post(
        '/api/v2/analytics/surveys/aggregates/query',
        {
          interval,
          groupBy: [
            'surveyFormId',
            'userId'
          ],
          metrics: [
            'oSurveyTotalScore',
            'oSurveyQuestionScore',
            'nSurveysSent',
            'nSurveysStarted',
            'nSurveysAbandoned',
            'nSurveysExpired'
          ]
        }
      );

      return {
        startDate: a.start_date,
        endDate: a.end_date,
        results: result.results || [],
      };
    },
  },

    {
    name: 'find_quality_survey_responses',
    description: 'Find individual Genesys Cloud survey responses for a date range. Returns the survey ID, conversation ID, survey form ID, status, and agent user IDs needed by the detailed survey tools.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        end_date: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        page_size: {
          type: 'number',
          description: 'Conversations per page, from 1 to 100. Defaults to 100.',
        },
        max_pages: {
          type: 'number',
          description: 'Maximum pages to retrieve. Defaults to 10 and cannot exceed 20.',
        },
      },
      required: ['start_date', 'end_date'],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const interval =
        `${a.start_date}T00:00:00.000Z/` +
        `${a.end_date}T23:59:59.999Z`;

      const pageSize = Math.max(
        1,
        Math.min(100, Number(a.page_size) || 100)
      );

      const maxPages = Math.max(
        1,
        Math.min(20, Number(a.max_pages) || 10)
      );

      const surveys = [];
let conversationsProcessed = 0;
let pagesProcessed = 0;
let reachedLastPage = false;

for (
  let pageNumber = 1;
  pageNumber <= maxPages;
  pageNumber++
) {
        const result = await gc.post(
          '/api/v2/analytics/conversations/details/query',
          {
            interval,
            order: 'asc',
            orderBy: 'conversationStart',
            paging: {
              pageSize,
              pageNumber,
            },
          }
        );

        const conversations = Array.isArray(result.conversations)
          ? result.conversations
          : [];

        if (!conversations.length) {
          break;
        }

        pagesProcessed++;
        conversationsProcessed += conversations.length;

        for (const conversation of conversations) {
          const conversationId =
            conversation.conversationId ||
            conversation.id ||
            null;

          const conversationSurveys = Array.isArray(
            conversation.surveys
          )
            ? conversation.surveys
            : [];

          const agentUserIds = [
            ...new Set(
              (conversation.participants || [])
                .filter(
                  (participant) =>
                    String(
                      participant.purpose || ''
                    ).toLowerCase() === 'agent'
                )
                .map(
                  (participant) =>
                    participant.userId ||
                    participant.user?.id
                )
                .filter(Boolean)
            ),
          ];

          for (const survey of conversationSurveys) {
            const surveyId =
              survey.surveyId ||
              survey.id ||
              null;

            if (!surveyId) {
              continue;
            }

            surveys.push({
              surveyId,
              conversationId,
              surveyFormId:
                survey.surveyFormId ||
                survey.formId ||
                survey.surveyForm?.id ||
                null,
              status:
                survey.status ||
                survey.surveyStatus ||
                null,
              agentUserIds,
              conversationStart:
                conversation.conversationStart ||
                null,
              conversationEnd:
                conversation.conversationEnd ||
                null,
            });
          }
        }

if (conversations.length < pageSize) {
  reachedLastPage = true;
  break;
}
      }

      const uniqueSurveys = [
        ...new Map(
          surveys.map((survey) => [
            survey.surveyId,
            survey,
          ])
        ).values(),
      ];

      return {
        startDate: a.start_date,
        endDate: a.end_date,
        surveysFound: uniqueSurveys.length,
        conversationsProcessed,
        pagesProcessed,
        truncated:
          pagesProcessed >= maxPages &&
          !reachedLastPage,
        surveys: uniqueSurveys,
      };
    },
  },
  {
    name: 'get_quality_survey',
    description: 'Get one Genesys Cloud Quality Management survey response by survey ID, including its status, answers, and scoring data.',
    inputSchema: {
      type: 'object',
      properties: {
        survey_id: {
          type: 'string',
          description: 'Genesys Cloud survey ID',
        },
      },
      required: ['survey_id'],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const surveyId = pathId(
        'survey id',
        a.survey_id
      );

      const survey = await gc.get(
        `/api/v2/quality/surveys/${surveyId}`
      );

      return {
        surveyId,
        survey,
      };
    },
  },

  {
    name: 'get_quality_survey_form',
    description: 'Get a published Genesys Cloud survey form by form ID, including its question groups, questions, question types, answer options, and scoring configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        form_id: {
          type: 'string',
          description: 'Genesys Cloud published survey form ID',
        },
      },
      required: ['form_id'],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const formId = pathId(
        'survey form id',
        a.form_id
      );

      const form = await gc.get(
        `/api/v2/quality/publishedforms/surveys/${formId}`
      );

      return {
        formId,
        form,
      };
    },
  },

  {
    name: 'get_quality_survey_question_scores',
    description: 'Get the individual answers and scoring data from one Genesys Cloud Quality Management survey response.',
    inputSchema: {
      type: 'object',
      properties: {
        survey_id: {
          type: 'string',
          description: 'Genesys Cloud survey ID',
        },
      },
      required: ['survey_id'],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const surveyId = pathId(
        'survey id',
        a.survey_id
      );

      const survey = await gc.get(
        `/api/v2/quality/surveys/${surveyId}`
      );

      return {
        surveyId,
        conversationId: survey.conversationId || null,
        surveyFormId:
          survey.surveyForm?.id ||
          survey.surveyFormId ||
          survey.formId ||
          null,
        status: survey.status || null,
        answers: survey.answers || null,
        survey,
      };
    },
  },
      // ----- conversations & interaction details -----
    {
    name: 'search_conversations_by_attribute',
    description: 'Search all Genesys Cloud interactions in a date range for a custom participant attribute. Checks every participant attribute and returns matching conversation IDs, participants, and custom attributes. The attribute value is optional.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format.',
        },
        end_date: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format. The inclusive range cannot exceed 7 calendar days.',
        },
        attribute_name: {
          type: 'string',
          description: 'Custom participant attribute name to find, for example TestingSetExtraData.',
        },
        attribute_value: {
          type: 'string',
          description: 'Optional attribute value to match. When omitted, any participant containing the attribute is returned.',
        },
        match_type: {
          type: 'string',
          enum: ['exact', 'contains'],
          description: 'How to compare attribute_value. Defaults to exact.',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Use case-sensitive matching. Defaults to false.',
        },
        page_size: {
          type: 'number',
          description: 'Conversations retrieved per page, from 1 to 100. Defaults to 100.',
        },
        max_pages: {
          type: 'number',
          description: 'Maximum pages to inspect, from 1 to 50. Defaults to 50.',
        },
      },
      required: [
        'start_date',
        'end_date',
        'attribute_name',
      ],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const datePattern = /^\d{4}-\d{2}-\d{2}$/;

      if (
        !datePattern.test(a.start_date) ||
        !datePattern.test(a.end_date)
      ) {
        throw new GenesysError(
          'start_date and end_date must use YYYY-MM-DD format.',
          400
        );
      }

      const startDate = new Date(
        `${a.start_date}T00:00:00.000Z`
      );

      const endDate = new Date(
        `${a.end_date}T00:00:00.000Z`
      );

      if (
        Number.isNaN(startDate.getTime()) ||
        Number.isNaN(endDate.getTime())
      ) {
        throw new GenesysError(
          'start_date or end_date is not a valid date.',
          400
        );
      }

      if (endDate < startDate) {
        throw new GenesysError(
          'end_date must be on or after start_date.',
          400
        );
      }

      const calendarDays =
        Math.floor(
          (
            endDate.getTime() -
            startDate.getTime()
          ) /
          86400000
        ) + 1;

      if (calendarDays > 7) {
        throw new GenesysError(
          'The date range cannot exceed 7 calendar days. Divide larger searches into smaller requests.',
          400
        );
      }

      const attributeName = String(
        a.attribute_name || ''
      ).trim();

      if (!attributeName) {
        throw new GenesysError(
          'attribute_name is required.',
          400
        );
      }

      const hasRequestedValue =
        a.attribute_value !== undefined &&
        a.attribute_value !== null;

      const requestedValue =
        hasRequestedValue
          ? String(a.attribute_value)
          : null;

      const matchType =
        a.match_type || 'exact';

      const caseSensitive =
        a.case_sensitive === true;

      const pageSize = Math.max(
        1,
        Math.min(
          100,
          Math.floor(
            Number(a.page_size) || 100
          )
        )
      );

      const maxPages = Math.max(
        1,
        Math.min(
          50,
          Math.floor(
            Number(a.max_pages) || 50
          )
        )
      );

      const interval =
        `${a.start_date}T00:00:00.000Z/` +
        `${a.end_date}T23:59:59.999Z`;

      function normalize(value) {
        const text = String(value);

        return caseSensitive
          ? text
          : text.toLowerCase();
      }

      function nameMatches(name) {
        return (
          normalize(name) ===
          normalize(attributeName)
        );
      }

      function valueMatches(value) {
        if (!hasRequestedValue) {
          return true;
        }

        const actualValue =
          normalize(value);

        const expectedValue =
          normalize(requestedValue);

        if (matchType === 'contains') {
          return actualValue.includes(
            expectedValue
          );
        }

        return (
          actualValue === expectedValue
        );
      }

      const matchesByConversation =
        new Map();

      let pagesProcessed = 0;
      let conversationsProcessed = 0;
      let participantsProcessed = 0;
      let attributesProcessed = 0;
      let reachedLastPage = false;
      let reportedTotalHits = null;

      for (
        let pageNumber = 1;
        pageNumber <= maxPages;
        pageNumber++
      ) {
        const result = await gc.post(
          '/api/v2/analytics/conversations/details/query',
          {
            interval,
            order: 'asc',
            orderBy: 'conversationStart',
            paging: {
              pageSize,
              pageNumber,
            },
          }
        );

        if (
          typeof result.totalHits === 'number' &&
          Number.isFinite(result.totalHits)
        ) {
          reportedTotalHits =
            result.totalHits;
        }

        const conversations =
          Array.isArray(
            result.conversations
          )
            ? result.conversations
            : [];

        if (!conversations.length) {
          reachedLastPage = true;
          break;
        }

        pagesProcessed++;
        conversationsProcessed +=
          conversations.length;

        for (
          const conversation of conversations
        ) {
          const conversationId =
            conversation.conversationId ||
            conversation.id ||
            null;

          if (!conversationId) {
            continue;
          }

          const participants =
            Array.isArray(
              conversation.participants
            )
              ? conversation.participants
              : [];

          participantsProcessed +=
            participants.length;

          const participantMatches = [];

          for (
            const participant of participants
          ) {
            const attributes =
              participant.attributes &&
              typeof participant.attributes ===
                'object' &&
              !Array.isArray(
                participant.attributes
              )
                ? participant.attributes
                : {};

            const attributeEntries =
              Object.entries(attributes);

            attributesProcessed +=
              attributeEntries.length;

            const matchedAttributes =
              attributeEntries
                .filter(([name, value]) => {
                  return (
                    nameMatches(name) &&
                    valueMatches(value)
                  );
                })
                .map(([name, value]) => ({
                  name,
                  value,
                }));

            if (!matchedAttributes.length) {
              continue;
            }

            participantMatches.push({
              participantId:
                participant.participantId ||
                participant.id ||
                null,
              participantName:
                participant.participantName ||
                participant.name ||
                null,
              purpose:
                participant.purpose ||
                null,
              userId:
                participant.userId ||
                participant.user?.id ||
                null,
              matchedAttributes,
              allAttributes: attributes,
            });
          }

          if (!participantMatches.length) {
            continue;
          }

          matchesByConversation.set(
            conversationId,
            {
              conversationId,
              conversationStart:
                conversation.conversationStart ||
                null,
              conversationEnd:
                conversation.conversationEnd ||
                null,
              participants:
                participantMatches,
            }
          );
        }

        if (
          conversations.length < pageSize
        ) {
          reachedLastPage = true;
          break;
        }
      }

      const matches = [
        ...matchesByConversation.values(),
      ];

      const participantMatches =
        matches.reduce(
          (total, conversation) =>
            total +
            conversation.participants.length,
          0
        );

      const attributeMatches =
        matches.reduce(
          (conversationTotal, conversation) =>
            conversationTotal +
            conversation.participants.reduce(
              (participantTotal, participant) =>
                participantTotal +
                participant.matchedAttributes.length,
              0
            ),
          0
        );

      const truncated =
        !reachedLastPage &&
        pagesProcessed >= maxPages;

      return {
        startDate: a.start_date,
        endDate: a.end_date,
        calendarDays,
        attributeName,
        attributeValue:
          hasRequestedValue
            ? requestedValue
            : null,
        matchType,
        caseSensitive,
        pageSize,
        maxPages,
        reportedTotalHits,
        pagesProcessed,
        conversationsProcessed,
        participantsProcessed,
        attributesProcessed,
        conversationsMatched:
          matches.length,
        participantMatches,
        attributeMatches,
        truncated,
        matches,
        note: truncated
          ? 'The search reached max_pages before confirming the final page. Reduce the date range or divide the search into smaller requests.'
          : 'The requested date range was fully scanned.',
      };
    },
  },
  {
    name: 'get_conversation_details',
    description: 'Get a comprehensive read-only view of one Genesys Cloud conversation. Accepts a conversation ID or full Genesys interaction URL and returns ANI, DNIS, timing, media, participants, custom participant attributes, flows, queues, agents, transfers, wrap-up data, recordings, voice-quality metrics, surveys, evaluations, and routing details when available.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation: {
          type: 'string',
          description: 'Genesys Cloud conversation ID or full interaction URL',
        },
        include_raw: {
          type: 'boolean',
          description: 'Include the complete raw operational conversation and analytics detail responses. Defaults to false.',
        },
      },
      required: ['conversation'],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const conversationId = conversationIdFromInput(
        a.conversation
      );

      const [
        operationalResult,
        analyticsResult,
      ] = await Promise.allSettled([
        gc.get(
          `/api/v2/conversations/${conversationId}`
        ),
        gc.get(
          `/api/v2/analytics/conversations/${conversationId}/details`
        ),
      ]);

      const operational =
        operationalResult.status === 'fulfilled'
          ? operationalResult.value
          : null;

      const analytics =
        analyticsResult.status === 'fulfilled'
          ? analyticsResult.value
          : null;

      if (!operational && !analytics) {
        const operationalError =
          operationalResult.reason?.message ||
          'Operational conversation request failed';

        const analyticsError =
          analyticsResult.reason?.message ||
          'Analytics conversation request failed';

        throw new GenesysError(
          `Unable to retrieve conversation ${conversationId}. ` +
          `Operational API: ${operationalError}. ` +
          `Analytics API: ${analyticsError}.`,
          operationalResult.reason?.status ||
            analyticsResult.reason?.status ||
            502
        );
      }

      function firstDefined(...values) {
        return values.find(
          (value) =>
            value !== undefined &&
            value !== null &&
            value !== ''
        );
      }

      function durationMs(start, end) {
        if (!start || !end) {
          return null;
        }

        const value =
          new Date(end).getTime() -
          new Date(start).getTime();

        return Number.isFinite(value) && value >= 0
          ? value
          : null;
      }

      function sessionsFor(participant) {
        return Array.isArray(participant?.sessions)
          ? participant.sessions
          : [];
      }

      function segmentsFor(participant) {
        return sessionsFor(participant).flatMap(
          (session) =>
            Array.isArray(session.segments)
              ? session.segments.map((segment) => ({
                  session,
                  segment,
                }))
              : []
        );
      }

      function metricsFor(participant) {
        return sessionsFor(participant).flatMap(
          (session) =>
            Array.isArray(session.metrics)
              ? session.metrics.map((metric) => ({
                  session,
                  metric,
                }))
              : []
        );
      }

      function metricValues(participant, metricName) {
        return metricsFor(participant)
          .filter(
            ({ metric }) =>
              metric?.name === metricName
          )
          .map(({ metric }) => metric.value)
          .filter(
            (value) =>
              typeof value === 'number' &&
              Number.isFinite(value)
          );
      }

      function sumMetric(participant, metricName) {
        const values = metricValues(
          participant,
          metricName
        );

        return values.length
          ? values.reduce(
              (total, value) => total + value,
              0
            )
          : null;
      }

      function minimumMetric(
        participants,
        metricNames
      ) {
        const values = participants.flatMap(
          (participant) =>
            metricNames.flatMap((metricName) =>
              metricValues(
                participant,
                metricName
              )
            )
        );

        return values.length
          ? Math.min(...values)
          : null;
      }

      const operationalParticipants = Array.isArray(
        operational?.participants
      )
        ? operational.participants
        : [];

      const analyticsParticipants = Array.isArray(
        analytics?.participants
      )
        ? analytics.participants
        : [];

      const operationalById = new Map(
        operationalParticipants
          .filter((participant) => participant?.id)
          .map((participant) => [
            participant.id,
            participant,
          ])
      );

      const analyticsById = new Map(
        analyticsParticipants
          .filter(
            (participant) =>
              participant?.participantId
          )
          .map((participant) => [
            participant.participantId,
            participant,
          ])
      );

      const participantIds = [
        ...new Set([
          ...operationalById.keys(),
          ...analyticsById.keys(),
        ]),
      ];

      const participants = participantIds.map(
        (participantId) => {
          const operationalParticipant =
            operationalById.get(participantId) || {};

          const analyticsParticipant =
            analyticsById.get(participantId) || {};

          const sessions = sessionsFor(
            analyticsParticipant
          );

          const segments = segmentsFor(
            analyticsParticipant
          );

          const attributes =
            operationalParticipant.attributes &&
            typeof operationalParticipant.attributes ===
              'object'
              ? operationalParticipant.attributes
              : {};

          const queues = [
            ...new Map(
              segments
                .filter(
                  ({ segment }) =>
                    segment.queueId
                )
                .map(({ segment }) => [
                  segment.queueId,
                  {
                    id: segment.queueId,
                    name:
                      segment.queueName ||
                      null,
                  },
                ])
            ).values(),
          ];

          const flows = [
            ...new Map(
              segments
                .filter(
                  ({ segment }) =>
                    segment.flowId
                )
                .map(({ segment }) => [
                  segment.flowId,
                  {
                    id: segment.flowId,
                    name:
                      segment.flowName ||
                      null,
                    version:
                      segment.flowVersion ||
                      null,
                    type:
                      segment.segmentType ||
                      null,
                  },
                ])
            ).values(),
          ];

          const wrapUpCodes = [
            ...new Map(
              segments
                .filter(
                  ({ segment }) =>
                    segment.wrapUpCode
                )
                .map(({ segment }) => [
                  segment.wrapUpCode,
                  {
                    id: segment.wrapUpCode,
                    name:
                      segment.wrapUpCodeName ||
                      null,
                  },
                ])
            ).values(),
          ];

          const disconnectReasons = [
            ...new Set(
              segments
                .map(
                  ({ segment }) =>
                    segment.disconnectType ||
                    segment.disconnectReason
                )
                .filter(Boolean)
            ),
          ];

          const mediaTypes = [
            ...new Set(
              sessions
                .map(
                  (session) =>
                    session.mediaType
                )
                .filter(Boolean)
            ),
          ];

          const directions = [
            ...new Set(
              sessions
                .map(
                  (session) =>
                    session.direction
                )
                .filter(Boolean)
            ),
          ];

          const recordingIds = [
            ...new Set(
              [
                ...sessions.map(
                  (session) =>
                    session.recordingId
                ),
                ...segments.map(
                  ({ segment }) =>
                    segment.recordingId
                ),
              ].filter(Boolean)
            ),
          ];

          return {
            participantId,
            name:
              firstDefined(
                operationalParticipant.name,
                analyticsParticipant.participantName
              ) || null,
            purpose:
              firstDefined(
                operationalParticipant.purpose,
                analyticsParticipant.purpose
              ) || null,
            userId:
              firstDefined(
                operationalParticipant.userId,
                operationalParticipant.user?.id,
                analyticsParticipant.userId
              ) || null,
            externalContactId:
              firstDefined(
                operationalParticipant.externalContactId,
                operationalParticipant.externalContact?.id,
                analyticsParticipant.externalContactId
              ) || null,
            ani:
              firstDefined(
                operationalParticipant.ani,
                ...sessions.map(
                  (session) => session.ani
                )
              ) || null,
            aniName:
              firstDefined(
                operationalParticipant.aniName,
                ...sessions.map(
                  (session) =>
                    session.aniName
                )
              ) || null,
            dnis:
              firstDefined(
                operationalParticipant.dnis,
                ...sessions.map(
                  (session) => session.dnis
                )
              ) || null,
            address:
              firstDefined(
                operationalParticipant.address,
                analyticsParticipant.externalAddress
              ) || null,
            connectedTime:
              operationalParticipant.connectedTime ||
              null,
            endTime:
              operationalParticipant.endTime ||
              null,
            mediaTypes,
            directions,
            attributes,
            queues,
            flows,
            wrapUpCodes,
            disconnectReasons,
            recordingIds,
            metrics: {
              alertMs: sumMetric(
                analyticsParticipant,
                'tAlert'
              ),
              talkMs: sumMetric(
                analyticsParticipant,
                'tTalk'
              ),
              holdMs: sumMetric(
                analyticsParticipant,
                'tHeld'
              ),
              acwMs: sumMetric(
                analyticsParticipant,
                'tAcw'
              ),
              handleMs: sumMetric(
                analyticsParticipant,
                'tHandle'
              ),
              interactMs: sumMetric(
                analyticsParticipant,
                'tInteract'
              ),
              ivrMs: sumMetric(
                analyticsParticipant,
                'tIvr'
              ),
              flowMs: sumMetric(
                analyticsParticipant,
                'tFlow'
              ),
              answeredCount: sumMetric(
                analyticsParticipant,
                'nAnswered'
              ),
              transferredCount: sumMetric(
                analyticsParticipant,
                'nTransferred'
              ),
            },
            sessions: sessions.map(
              (session) => ({
                sessionId:
                  session.sessionId ||
                  session.id ||
                  null,
                mediaType:
                  session.mediaType ||
                  null,
                direction:
                  session.direction ||
                  null,
                ani:
                  session.ani ||
                  null,
                aniName:
                  session.aniName ||
                  null,
                dnis:
                  session.dnis ||
                  null,
                protocolCallId:
                  session.protocolCallId ||
                  null,
                recordingId:
                  session.recordingId ||
                  null,
                edgeId:
                  session.edgeId ||
                  null,
                peerId:
                  session.peerId ||
                  null,
                segments:
                  Array.isArray(
                    session.segments
                  )
                    ? session.segments
                    : [],
              })
            ),
          };
        }
      );

      const attributeParticipants =
        participants
          .filter(
            (participant) =>
              Object.keys(
                participant.attributes
              ).length > 0
          )
          .map((participant) => ({
            participantId:
              participant.participantId,
            participantName:
              participant.name,
            purpose:
              participant.purpose,
            attributes:
              participant.attributes,
          }));

      const flattenedAttributes =
        attributeParticipants.flatMap(
          (participant) =>
            Object.entries(
              participant.attributes
            ).map(([name, value]) => ({
              participantId:
                participant.participantId,
              participantName:
                participant.participantName,
              purpose:
                participant.purpose,
              name,
              value,
            }))
        );

      const allSegments =
        analyticsParticipants.flatMap(
          (participant) =>
            segmentsFor(participant).map(
              ({ session, segment }) => ({
                participantId:
                  participant.participantId ||
                  null,
                participantPurpose:
                  participant.purpose ||
                  null,
                participantName:
                  participant.participantName ||
                  null,
                sessionId:
                  session.sessionId ||
                  session.id ||
                  null,
                mediaType:
                  session.mediaType ||
                  null,
                direction:
                  session.direction ||
                  null,
                ...segment,
              })
            )
        );

      const flows = [
        ...new Map(
          allSegments
            .filter(
              (segment) => segment.flowId
            )
            .map((segment) => [
              segment.flowId,
              {
                id: segment.flowId,
                name:
                  segment.flowName ||
                  null,
                version:
                  segment.flowVersion ||
                  null,
                participantId:
                  segment.participantId,
                participantPurpose:
                  segment.participantPurpose,
                segmentType:
                  segment.segmentType ||
                  null,
                start:
                  segment.segmentStart ||
                  null,
                end:
                  segment.segmentEnd ||
                  null,
                durationMs: durationMs(
                  segment.segmentStart,
                  segment.segmentEnd
                ),
                exitReason:
                  segment.flowOutType ||
                  segment.disconnectType ||
                  null,
              },
            ])
        ).values(),
      ];

      const queues = [
        ...new Map(
          allSegments
            .filter(
              (segment) => segment.queueId
            )
            .map((segment) => [
              segment.queueId,
              {
                id: segment.queueId,
                name:
                  segment.queueName ||
                  null,
              },
            ])
        ).values(),
      ];

      const wrapUpCodes = [
        ...new Map(
          allSegments
            .filter(
              (segment) =>
                segment.wrapUpCode
            )
            .map((segment) => [
              segment.wrapUpCode,
              {
                id: segment.wrapUpCode,
                name:
                  segment.wrapUpCodeName ||
                  null,
                participantId:
                  segment.participantId,
              },
            ])
        ).values(),
      ];

      const transfers = allSegments
        .filter(
          (segment) =>
            segment.segmentType ===
              'transfer' ||
            segment.transferType ||
            segment.transferTargetAddress ||
            segment.destinationParticipantId
        )
        .map((segment) => ({
          participantId:
            segment.participantId,
          participantPurpose:
            segment.participantPurpose,
          start:
            segment.segmentStart ||
            null,
          end:
            segment.segmentEnd ||
            null,
          transferType:
            segment.transferType ||
            segment.segmentType ||
            null,
          destinationParticipantId:
            segment.destinationParticipantId ||
            null,
          targetAddress:
            segment.transferTargetAddress ||
            null,
          queueId:
            segment.queueId ||
            null,
          disconnectType:
            segment.disconnectType ||
            null,
        }));

      const surveys = Array.isArray(
        analytics?.surveys
      )
        ? analytics.surveys.map((survey) => ({
            surveyId:
              survey.surveyId ||
              survey.id ||
              null,
            surveyFormId:
              survey.surveyFormId ||
              survey.formId ||
              survey.surveyForm?.id ||
              null,
            status:
              survey.status ||
              survey.surveyStatus ||
              null,
            totalScore:
              survey.totalScore ??
              survey.score ??
              null,
            userId:
              survey.userId ||
              null,
          }))
        : [];

      const evaluations = Array.isArray(
        analytics?.evaluations
      )
        ? analytics.evaluations.map(
            (evaluation) => ({
              evaluationId:
                evaluation.evaluationId ||
                evaluation.id ||
                null,
              evaluationFormId:
                evaluation.evaluationFormId ||
                evaluation.formId ||
                evaluation.evaluationForm?.id ||
                null,
              userId:
                evaluation.userId ||
                null,
              evaluatorId:
                evaluation.evaluatorId ||
                null,
              status:
                evaluation.status ||
                null,
              totalScore:
                evaluation.totalScore ??
                evaluation.score ??
                null,
            })
          )
        : [];

      const allSessions =
        analyticsParticipants.flatMap(
          (participant) =>
            sessionsFor(participant)
        );

      const customerParticipants =
        participants.filter(
          (participant) =>
            String(
              participant.purpose || ''
            ).toLowerCase() === 'customer'
        );

      const ani =
        firstDefined(
          operational?.ani,
          ...customerParticipants.map(
            (participant) =>
              participant.ani
          ),
          ...allSessions.map(
            (session) => session.ani
          )
        ) || null;

      const aniName =
        firstDefined(
          operational?.aniName,
          ...customerParticipants.map(
            (participant) =>
              participant.aniName ||
              participant.name
          ),
          ...allSessions.map(
            (session) => session.aniName
          )
        ) || null;

      const dnis =
        firstDefined(
          operational?.dnis,
          ...customerParticipants.map(
            (participant) =>
              participant.dnis
          ),
          ...allSessions.map(
            (session) => session.dnis
          )
        ) || null;

      const startTime =
        firstDefined(
          analytics?.conversationStart,
          operational?.startTime
        ) || null;

      const endTime =
        firstDefined(
          analytics?.conversationEnd,
          operational?.endTime
        ) || null;

      const mediaTypes = [
        ...new Set(
          allSessions
            .map(
              (session) =>
                session.mediaType
            )
            .filter(Boolean)
        ),
      ];

      const directions = [
        ...new Set(
          allSessions
            .map(
              (session) =>
                session.direction
            )
            .filter(Boolean)
        ),
      ];

      const recordingIds = [
        ...new Set(
          participants.flatMap(
            (participant) =>
              participant.recordingIds
          )
        ),
      ];

      const disconnectReasons = [
        ...new Set(
          participants.flatMap(
            (participant) =>
              participant.disconnectReasons
          )
        ),
      ];

      const summary = {
        conversationId,
        startTime,
        endTime,
        durationMs: durationMs(
          startTime,
          endTime
        ),
        directions,
        mediaTypes,
        ani,
        aniName,
        dnis,
        recorded:
          recordingIds.length > 0 ||
          Boolean(
            analytics?.recordingState ||
            operational?.recordingState
          ),
        recordingIds,
        recordingState:
          analytics?.recordingState ||
          operational?.recordingState ||
          null,
        disconnectReasons,
        quality: {
          minimumMos: minimumMetric(
            analyticsParticipants,
            [
              'minMos',
              'oMediaStatsMinMos',
              'oExternalMediaStatsMinMos',
            ]
          ),
          minimumRFactor: minimumMetric(
            analyticsParticipants,
            [
              'minRFactor',
              'oMediaStatsMinRFactor',
              'oExternalMediaStatsMinRFactor',
            ]
          ),
        },
        flows,
        queues,
        transfers,
        wrapUpCodes,
        surveys,
        evaluations,
        customAttributes: {
          participantCount:
            attributeParticipants.length,
          attributeCount:
            flattenedAttributes.length,
          byParticipant:
            attributeParticipants,
          flattened:
            flattenedAttributes,
        },
        participants,
        retrieval: {
          operationalConversationAvailable:
            Boolean(operational),
          analyticsDetailsAvailable:
            Boolean(analytics),
          operationalError:
            operationalResult.status ===
            'rejected'
              ? operationalResult.reason
                  ?.message || 'Request failed'
              : null,
          analyticsError:
            analyticsResult.status ===
            'rejected'
              ? analyticsResult.reason
                  ?.message || 'Request failed'
              : null,
        },
      };

      if (a.include_raw === true) {
        summary.raw = {
          operationalConversation:
            operational,
          analyticsDetails:
            analytics,
        };
      }

      return summary;
    },
  },
  // ----- queues & routing -----
    {
    name: 'trace_interaction',
    description: 'Reconstruct a Genesys Cloud interaction as a chronological journey. Accepts a conversation ID or full Genesys interaction URL and returns a summary, ordered trace events, participants, custom attributes, visualization-ready nodes and edges, and a Mermaid flowchart. Use this tool when the user asks what happened during an interaction, how an interaction was routed, where it transferred, which queues, flows, or agents handled it, or wants to visualize the interaction path.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation: {
          type: 'string',
          description:
            'Genesys Cloud conversation ID or full interaction URL',
        },
        include_attributes: {
          type: 'boolean',
          description:
            'Include custom participant attributes in the result. Defaults to true.',
        },
        include_raw_segments: {
          type: 'boolean',
          description:
            'Include the underlying analytics segments used to build the trace. Defaults to false.',
        },
      },
      required: [
        'conversation',
      ],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const conversationId =
        conversationIdFromInput(
          a.conversation
        );

      const includeAttributes =
        a.include_attributes !== false;

      const includeRawSegments =
        a.include_raw_segments === true;

      const [
        operationalResult,
        analyticsResult,
      ] = await Promise.allSettled([
        gc.get(
          `/api/v2/conversations/${conversationId}`
        ),
        gc.get(
          `/api/v2/analytics/conversations/${conversationId}/details`
        ),
      ]);

      const operational =
        operationalResult.status ===
        'fulfilled'
          ? operationalResult.value
          : null;

      const analytics =
        analyticsResult.status ===
        'fulfilled'
          ? analyticsResult.value
          : null;

      if (!operational && !analytics) {
        const operationalError =
          operationalResult.reason
            ?.message ||
          'Operational conversation request failed';

        const analyticsError =
          analyticsResult.reason
            ?.message ||
          'Analytics conversation request failed';

        throw new GenesysError(
          `Unable to retrieve conversation ${conversationId}. ` +
          `Operational API: ${operationalError}. ` +
          `Analytics API: ${analyticsError}.`,
          operationalResult.reason
            ?.status ||
            analyticsResult.reason
              ?.status ||
            502
        );
      }

      function firstDefined(
        ...values
      ) {
        return values.find(
          (value) =>
            value !== undefined &&
            value !== null &&
            value !== ''
        );
      }

      function timestampMs(value) {
        if (!value) {
          return null;
        }

        const milliseconds =
          new Date(value).getTime();

        return Number.isFinite(
          milliseconds
        )
          ? milliseconds
          : null;
      }

      function durationMs(
        start,
        end
      ) {
        const startMs =
          timestampMs(start);

        const endMs =
          timestampMs(end);

        if (
          startMs === null ||
          endMs === null ||
          endMs < startMs
        ) {
          return null;
        }

        return endMs - startMs;
      }

      function formatDuration(
        milliseconds
      ) {
        if (
          milliseconds === null ||
          milliseconds === undefined ||
          !Number.isFinite(
            milliseconds
          )
        ) {
          return null;
        }

        const totalSeconds =
          Math.max(
            0,
            Math.round(
              milliseconds / 1000
            )
          );

        const hours =
          Math.floor(
            totalSeconds / 3600
          );

        const minutes =
          Math.floor(
            (
              totalSeconds % 3600
            ) / 60
          );

        const seconds =
          totalSeconds % 60;

        if (hours) {
          return (
            `${hours}h ` +
            `${minutes}m ` +
            `${seconds}s`
          );
        }

        if (minutes) {
          return (
            `${minutes}m ` +
            `${seconds}s`
          );
        }

        return `${seconds}s`;
      }

      function normalizePurpose(
        value
      ) {
        return String(
          value || 'unknown'
        ).toLowerCase();
      }

      function cleanLabel(
        value,
        fallback
      ) {
        const text = String(
          value ||
          fallback ||
          'Unknown'
        )
          .replace(
            /\s+/g,
            ' '
          )
          .trim();

        return text || 'Unknown';
      }

      function escapeMermaid(
        value
      ) {
        return cleanLabel(
          value,
          'Unknown'
        )
          .replace(
            /"/g,
            "'"
          )
          .replace(
            /\[/g,
            '('
          )
          .replace(
            /\]/g,
            ')'
          )
          .replace(
            /\{/g,
            '('
          )
          .replace(
            /\}/g,
            ')'
          )
          .replace(
            /\|/g,
            '/'
          );
      }

      const operationalParticipants =
        Array.isArray(
          operational?.participants
        )
          ? operational.participants
          : [];

      const analyticsParticipants =
        Array.isArray(
          analytics?.participants
        )
          ? analytics.participants
          : [];

      const operationalById =
        new Map(
          operationalParticipants
            .filter(
              (participant) =>
                participant?.id
            )
            .map(
              (participant) => [
                participant.id,
                participant,
              ]
            )
        );

      const analyticsById =
        new Map(
          analyticsParticipants
            .filter(
              (participant) =>
                participant
                  ?.participantId
            )
            .map(
              (participant) => [
                participant
                  .participantId,
                participant,
              ]
            )
        );

      const participantIds = [
        ...new Set([
          ...operationalById.keys(),
          ...analyticsById.keys(),
        ]),
      ];

      const participants =
        participantIds.map(
          (
            participantId,
            index
          ) => {
            const operationalParticipant =
              operationalById.get(
                participantId
              ) || {};

            const analyticsParticipant =
              analyticsById.get(
                participantId
              ) || {};

            const sessions =
              Array.isArray(
                analyticsParticipant
                  .sessions
              )
                ? analyticsParticipant
                    .sessions
                : [];

            const attributes =
              operationalParticipant
                .attributes &&
              typeof operationalParticipant
                .attributes ===
                'object' &&
              !Array.isArray(
                operationalParticipant
                  .attributes
              )
                ? operationalParticipant
                    .attributes
                : {};

            const purpose =
              firstDefined(
                operationalParticipant
                  .purpose,
                analyticsParticipant
                  .purpose
              ) || 'unknown';

            const name =
              firstDefined(
                operationalParticipant
                  .name,
                analyticsParticipant
                  .participantName,
                operationalParticipant
                  .user?.name
              ) || null;

            const userId =
              firstDefined(
                operationalParticipant
                  .userId,
                operationalParticipant
                  .user?.id,
                analyticsParticipant
                  .userId
              ) || null;

            const ani =
              firstDefined(
                operationalParticipant
                  .ani,
                ...sessions.map(
                  (session) =>
                    session.ani
                )
              ) || null;

            const dnis =
              firstDefined(
                operationalParticipant
                  .dnis,
                ...sessions.map(
                  (session) =>
                    session.dnis
                )
              ) || null;

            return {
              participantId,
              sequence:
                index + 1,
              purpose,
              name,
              userId,
              externalContactId:
                firstDefined(
                  operationalParticipant
                    .externalContactId,
                  operationalParticipant
                    .externalContact?.id,
                  analyticsParticipant
                    .externalContactId
                ) || null,
              ani,
              aniName:
                firstDefined(
                  operationalParticipant
                    .aniName,
                  ...sessions.map(
                    (session) =>
                      session.aniName
                  )
                ) || null,
              dnis,
              address:
                firstDefined(
                  operationalParticipant
                    .address,
                  analyticsParticipant
                    .externalAddress
                ) || null,
              connectedTime:
                operationalParticipant
                  .connectedTime ||
                null,
              endTime:
                operationalParticipant
                  .endTime ||
                null,
              attributes:
                includeAttributes
                  ? attributes
                  : undefined,
            };
          }
        );

      const participantById =
        new Map(
          participants.map(
            (participant) => [
              participant
                .participantId,
              participant,
            ]
          )
        );

      const rawSegments = [];

      for (
        const participant of
          analyticsParticipants
      ) {
        const participantId =
          participant
            .participantId ||
          null;

        const participantSummary =
          participantId
            ? participantById.get(
                participantId
              )
            : null;

        const sessions =
          Array.isArray(
            participant.sessions
          )
            ? participant.sessions
            : [];

        for (
          const session of sessions
        ) {
          const segments =
            Array.isArray(
              session.segments
            )
              ? session.segments
              : [];

          for (
            let segmentIndex = 0;
            segmentIndex <
              segments.length;
            segmentIndex++
          ) {
            const segment =
              segments[
                segmentIndex
              ];

            rawSegments.push({
              participantId,
              participantName:
                participantSummary
                  ?.name ||
                participant
                  .participantName ||
                null,
              participantPurpose:
                participantSummary
                  ?.purpose ||
                participant.purpose ||
                null,
              userId:
                participantSummary
                  ?.userId ||
                participant.userId ||
                null,
              sessionId:
                session.sessionId ||
                session.id ||
                null,
              mediaType:
                session.mediaType ||
                null,
              direction:
                session.direction ||
                null,
              ani:
                session.ani ||
                null,
              aniName:
                session.aniName ||
                null,
              dnis:
                session.dnis ||
                null,
              protocolCallId:
                session.protocolCallId ||
                null,
              edgeId:
                session.edgeId ||
                null,
              peerId:
                session.peerId ||
                null,
              segmentIndex,
              segment,
            });
          }
        }
      }

      function deriveEventType(
        item
      ) {
        const segment =
          item.segment || {};

        const segmentType =
          String(
            segment.segmentType ||
            ''
          ).toLowerCase();

        const purpose =
          normalizePurpose(
            item.participantPurpose
          );

        if (
          segment.transferType ||
          segment
            .transferTargetAddress ||
          segment
            .destinationParticipantId ||
          segmentType === 'transfer'
        ) {
          return 'transfer';
        }

        if (
          segment.wrapUpCode ||
          segmentType === 'wrapup'
        ) {
          return 'wrapup';
        }

        if (
          segment.queueId ||
          segmentType === 'acd'
        ) {
          return 'queue';
        }

        if (
          segment.flowId ||
          purpose === 'ivr' ||
          purpose === 'bot' ||
          purpose === 'workflow'
        ) {
          return 'flow';
        }

        if (
          segmentType === 'hold' ||
          segmentType === 'held'
        ) {
          return 'hold';
        }

        if (
          segmentType === 'alert' ||
          segmentType ===
            'contacting'
        ) {
          return 'alert';
        }

        if (
          segmentType ===
            'interact' ||
          segmentType ===
            'connected'
        ) {
          if (
            purpose === 'agent'
          ) {
            return 'agent';
          }

          if (
            purpose ===
              'customer' ||
            purpose ===
              'external'
          ) {
            return 'customer';
          }

          return 'interaction';
        }

        if (
          segment.disconnectType ||
          segment
            .disconnectReason ||
          segmentType ===
            'disconnect'
        ) {
          return 'disconnect';
        }

        if (
          purpose === 'agent'
        ) {
          return 'agent';
        }

        if (
          purpose === 'customer' ||
          purpose === 'external'
        ) {
          return 'customer';
        }

        return (
          segmentType ||
          purpose ||
          'interaction'
        );
      }

      function deriveLabel(
        eventType,
        item
      ) {
        const segment =
          item.segment || {};

        if (
          eventType === 'queue'
        ) {
          return cleanLabel(
            segment.queueName,
            segment.queueId
              ? `Queue ${segment.queueId}`
              : 'Queue'
          );
        }

        if (
          eventType === 'flow'
        ) {
          return cleanLabel(
            segment.flowName,
            segment.flowId
              ? `Flow ${segment.flowId}`
              : 'Flow'
          );
        }

        if (
          eventType === 'agent'
        ) {
          return cleanLabel(
            item.participantName,
            item.userId
              ? `Agent ${item.userId}`
              : 'Agent'
          );
        }

        if (
          eventType === 'customer'
        ) {
          return cleanLabel(
            item.participantName ||
            item.aniName,
            item.ani ||
            'Customer'
          );
        }

        if (
          eventType === 'hold'
        ) {
          return 'Hold';
        }

        if (
          eventType === 'alert'
        ) {
          return cleanLabel(
            item.participantName,
            'Agent alerting'
          );
        }

        if (
          eventType === 'transfer'
        ) {
          return cleanLabel(
            segment
              .transferTargetAddress ||
            segment
              .destinationParticipantName,
            segment
              .destinationParticipantId
              ? `Transfer to ${segment.destinationParticipantId}`
              : 'Transfer'
          );
        }

        if (
          eventType === 'wrapup'
        ) {
          return cleanLabel(
            segment
              .wrapUpCodeName,
            segment.wrapUpCode
              ? `Wrap-up ${segment.wrapUpCode}`
              : 'Wrap-up'
          );
        }

        if (
          eventType ===
            'disconnect'
        ) {
          return cleanLabel(
            segment
              .disconnectType ||
            segment
              .disconnectReason,
            'Disconnect'
          );
        }

        return cleanLabel(
          item.segment
            ?.segmentType,
          eventType
        );
      }

      const trace = rawSegments
        .map(
          (item, index) => {
            const segment =
              item.segment || {};

            const startTime =
              segment.segmentStart ||
              segment.startTime ||
              segment.start ||
              null;

            const endTime =
              segment.segmentEnd ||
              segment.endTime ||
              segment.end ||
              null;

            const eventType =
              deriveEventType(
                item
              );

            const attributes =
              includeAttributes &&
              item.participantId
                ? participantById.get(
                    item.participantId
                  )?.attributes ||
                  {}
                : undefined;

            return {
              sourceIndex:
                index,
              startTime,
              endTime,
              startTimestamp:
                timestampMs(
                  startTime
                ),
              endTimestamp:
                timestampMs(
                  endTime
                ),
              eventType,
              label:
                deriveLabel(
                  eventType,
                  item
                ),
              participantId:
                item.participantId,
              participantName:
                item.participantName,
              participantPurpose:
                item.participantPurpose,
              userId:
                item.userId,
              mediaType:
                item.mediaType,
              direction:
                item.direction,
              sessionId:
                item.sessionId,
              queueId:
                segment.queueId ||
                null,
              queueName:
                segment.queueName ||
                null,
              flowId:
                segment.flowId ||
                null,
              flowName:
                segment.flowName ||
                null,
              flowVersion:
                segment.flowVersion ||
                null,
              segmentType:
                segment.segmentType ||
                null,
              transferType:
                segment.transferType ||
                null,
              transferTargetAddress:
                segment
                  .transferTargetAddress ||
                null,
              destinationParticipantId:
                segment
                  .destinationParticipantId ||
                null,
              wrapUpCodeId:
                segment.wrapUpCode ||
                null,
              wrapUpCodeName:
                segment
                  .wrapUpCodeName ||
                null,
              disconnectType:
                segment
                  .disconnectType ||
                null,
              disconnectReason:
                segment
                  .disconnectReason ||
                null,
              durationMs:
                durationMs(
                  startTime,
                  endTime
                ),
              attributes,
            };
          }
        )
        .sort(
          (left, right) => {
            const leftStart =
              left.startTimestamp ??
              Number.MAX_SAFE_INTEGER;

            const rightStart =
              right.startTimestamp ??
              Number.MAX_SAFE_INTEGER;

            if (
              leftStart !== rightStart
            ) {
              return (
                leftStart -
                rightStart
              );
            }

            const leftEnd =
              left.endTimestamp ??
              Number.MAX_SAFE_INTEGER;

            const rightEnd =
              right.endTimestamp ??
              Number.MAX_SAFE_INTEGER;

            if (
              leftEnd !== rightEnd
            ) {
              return (
                leftEnd -
                rightEnd
              );
            }

            return (
              left.sourceIndex -
              right.sourceIndex
            );
          }
        )
        .map(
          (event, index) => ({
            sequence:
              index + 1,
            eventId:
              `event-${index + 1}`,
            startTime:
              event.startTime,
            endTime:
              event.endTime,
            eventType:
              event.eventType,
            label:
              event.label,
            participantId:
              event.participantId,
            participantName:
              event.participantName,
            participantPurpose:
              event.participantPurpose,
            userId:
              event.userId,
            mediaType:
              event.mediaType,
            direction:
              event.direction,
            sessionId:
              event.sessionId,
            queueId:
              event.queueId,
            queueName:
              event.queueName,
            flowId:
              event.flowId,
            flowName:
              event.flowName,
            flowVersion:
              event.flowVersion,
            segmentType:
              event.segmentType,
            transferType:
              event.transferType,
            transferTargetAddress:
              event
                .transferTargetAddress,
            destinationParticipantId:
              event
                .destinationParticipantId,
            wrapUpCodeId:
              event.wrapUpCodeId,
            wrapUpCodeName:
              event.wrapUpCodeName,
            disconnectType:
              event.disconnectType,
            disconnectReason:
              event.disconnectReason,
            durationMs:
              event.durationMs,
            duration:
              formatDuration(
                event.durationMs
              ),
            attributes:
              event.attributes,
          })
        );

      const conversationStart =
        firstDefined(
          analytics
            ?.conversationStart,
          operational
            ?.startTime,
          ...trace.map(
            (event) =>
              event.startTime
          )
        ) || null;

      const conversationEnd =
        firstDefined(
          analytics
            ?.conversationEnd,
          operational
            ?.endTime
        ) ||
        trace
          .map(
            (event) =>
              event.endTime
          )
          .filter(Boolean)
          .sort()
          .at(-1) ||
        null;

      const customerParticipants =
        participants.filter(
          (participant) => {
            const purpose =
              normalizePurpose(
                participant.purpose
              );

            return (
              purpose ===
                'customer' ||
              purpose ===
                'external'
            );
          }
        );

      const ani =
        firstDefined(
          operational?.ani,
          ...customerParticipants.map(
            (participant) =>
              participant.ani
          ),
          ...rawSegments.map(
            (item) =>
              item.ani
          )
        ) || null;

      const aniName =
        firstDefined(
          operational?.aniName,
          ...customerParticipants.map(
            (participant) =>
              participant
                .aniName ||
              participant.name
          ),
          ...rawSegments.map(
            (item) =>
              item.aniName
          )
        ) || null;

      const dnis =
        firstDefined(
          operational?.dnis,
          ...customerParticipants.map(
            (participant) =>
              participant.dnis
          ),
          ...rawSegments.map(
            (item) =>
              item.dnis
          )
        ) || null;

      const queues = [
        ...new Map(
          trace
            .filter(
              (event) =>
                event.queueId
            )
            .map(
              (event) => [
                event.queueId,
                {
                  id:
                    event.queueId,
                  name:
                    event.queueName ||
                    null,
                },
              ]
            )
        ).values(),
      ];

      const flows = [
        ...new Map(
          trace
            .filter(
              (event) =>
                event.flowId
            )
            .map(
              (event) => [
                event.flowId,
                {
                  id:
                    event.flowId,
                  name:
                    event.flowName ||
                    null,
                  version:
                    event.flowVersion ||
                    null,
                },
              ]
            )
        ).values(),
      ];

      const agents = [
        ...new Map(
          participants
            .filter(
              (participant) =>
                normalizePurpose(
                  participant.purpose
                ) === 'agent'
            )
            .map(
              (participant) => [
                participant.userId ||
                participant
                  .participantId,
                {
                  participantId:
                    participant
                      .participantId,
                  userId:
                    participant
                      .userId,
                  name:
                    participant.name ||
                    null,
                },
              ]
            )
        ).values(),
      ];

      const transfers =
        trace.filter(
          (event) =>
            event.eventType ===
            'transfer'
        );

      const holds =
        trace.filter(
          (event) =>
            event.eventType ===
            'hold'
        );

      const totalHoldMs =
        holds.reduce(
          (total, event) =>
            total +
            (
              Number.isFinite(
                event.durationMs
              )
                ? event.durationMs
                : 0
            ),
          0
        );

      const wrapUpCodes = [
        ...new Map(
          trace
            .filter(
              (event) =>
                event.wrapUpCodeId
            )
            .map(
              (event) => [
                event
                  .wrapUpCodeId,
                {
                  id:
                    event
                      .wrapUpCodeId,
                  name:
                    event
                      .wrapUpCodeName ||
                    null,
                },
              ]
            )
        ).values(),
      ];

      const disconnectReasons = [
        ...new Set(
          trace
            .flatMap(
              (event) => [
                event
                  .disconnectType,
                event
                  .disconnectReason,
              ]
            )
            .filter(Boolean)
        ),
      ];

      const customAttributes =
        includeAttributes
          ? participants
              .filter(
                (participant) =>
                  participant
                    .attributes &&
                  Object.keys(
                    participant
                      .attributes
                  ).length
              )
              .map(
                (participant) => ({
                  participantId:
                    participant
                      .participantId,
                  participantName:
                    participant.name,
                  participantPurpose:
                    participant.purpose,
                  attributes:
                    participant
                      .attributes,
                })
              )
          : [];

      /*
       * Visualization nodes correspond one-to-one
       * with ordered trace events. This avoids the
       * model having to infer chronology.
       */
      const nodes =
        trace.map(
          (event) => ({
            id:
              `step-${event.sequence}`,
            sequence:
              event.sequence,
            type:
              event.eventType,
            label:
              event.label,
            subtitle:
              firstDefined(
                event.queueName,
                event.flowName,
                event.participantName,
                event.segmentType
              ) || null,
            startTime:
              event.startTime,
            endTime:
              event.endTime,
            durationMs:
              event.durationMs,
            duration:
              event.duration,
            participantId:
              event.participantId,
            userId:
              event.userId,
            queueId:
              event.queueId,
            flowId:
              event.flowId,
            mediaType:
              event.mediaType,
            direction:
              event.direction,
          })
        );

      const edges = [];

      for (
        let index = 1;
        index < nodes.length;
        index++
      ) {
        const previous =
          nodes[index - 1];

        const current =
          nodes[index];

        edges.push({
          id:
            `edge-${index}`,
          from:
            previous.id,
          to:
            current.id,
          label:
            current.type ===
              'transfer'
              ? (
                  trace[index]
                    .transferType ||
                  'transfer'
                )
              : null,
        });
      }

      const mermaidLines = [
        'flowchart LR',
      ];

      for (
        const node of nodes
      ) {
        let shapeStart = '[';
        let shapeEnd = ']';

        if (
          node.type === 'customer' ||
          node.type === 'agent'
        ) {
          shapeStart = '([';
          shapeEnd = '])';
        } else if (
          node.type === 'queue'
        ) {
          shapeStart = '[[';
          shapeEnd = ']]';
        } else if (
          node.type === 'flow'
        ) {
          shapeStart = '{{';
          shapeEnd = '}}';
        } else if (
          node.type ===
            'disconnect'
        ) {
          shapeStart = '([';
          shapeEnd = '])';
        }

        const durationText =
          node.duration
            ? `\\n${node.duration}`
            : '';

        mermaidLines.push(
          `  ${node.id.replace(
            /-/g,
            '_'
          )}${shapeStart}"${escapeMermaid(
            node.label
          )}${durationText}"${shapeEnd}`
        );
      }

      for (
        const edge of edges
      ) {
        const from =
          edge.from.replace(
            /-/g,
            '_'
          );

        const to =
          edge.to.replace(
            /-/g,
            '_'
          );

        if (edge.label) {
          mermaidLines.push(
            `  ${from} -->|"${escapeMermaid(
              edge.label
            )}"| ${to}`
          );
        } else {
          mermaidLines.push(
            `  ${from} --> ${to}`
          );
        }
      }

      const summary = {
        conversationId,
        conversationStart,
        conversationEnd,
        durationMs:
          durationMs(
            conversationStart,
            conversationEnd
          ),
        duration:
          formatDuration(
            durationMs(
              conversationStart,
              conversationEnd
            )
          ),
        ani,
        aniName,
        dnis,
        mediaTypes: [
          ...new Set(
            trace
              .map(
                (event) =>
                  event.mediaType
              )
              .filter(Boolean)
          ),
        ],
        directions: [
          ...new Set(
            trace
              .map(
                (event) =>
                  event.direction
              )
              .filter(Boolean)
          ),
        ],
        participantCount:
          participants.length,
        agentCount:
          agents.length,
        queueCount:
          queues.length,
        flowCount:
          flows.length,
        transferCount:
          transfers.length,
        holdCount:
          holds.length,
        totalHoldMs,
        totalHold:
          formatDuration(
            totalHoldMs
          ),
        eventCount:
          trace.length,
        queues,
        flows,
        agents,
        wrapUpCodes,
        disconnectReasons,
      };

      return {
        summary,
        trace,
        participants,
        customAttributes,
        visualization: {
          recommendedLayout:
            'horizontal_timeline',
          nodes,
          edges,
          mermaid:
            mermaidLines.join(
              '\n'
            ),
          legend: {
            customer:
              'External customer participant',
            flow:
              'Architect flow, IVR, bot, or workflow',
            queue:
              'ACD queue or queue segment',
            alert:
              'Agent alerting or contacting',
            agent:
              'Agent interaction',
            hold:
              'Hold segment',
            transfer:
              'Transfer event',
            wrapup:
              'After-call work or wrap-up',
            disconnect:
              'Interaction disconnect',
            interaction:
              'Other interaction segment',
          },
        },
        retrieval: {
          operationalConversationAvailable:
            Boolean(operational),
          analyticsDetailsAvailable:
            Boolean(analytics),
          operationalError:
            operationalResult.status ===
            'rejected'
              ? (
                  operationalResult
                    .reason?.message ||
                  'Request failed'
                )
              : null,
          analyticsError:
            analyticsResult.status ===
            'rejected'
              ? (
                  analyticsResult
                    .reason?.message ||
                  'Request failed'
                )
              : null,
        },
        rawSegments:
          includeRawSegments
            ? rawSegments
            : undefined,
        note:
          'The trace is ordered by segment start time. Simultaneous or overlapping participant segments can appear as adjacent events because a Genesys interaction may contain multiple active participants at the same time.',
      };
    },
  },
   {
    name: 'find_repeat_contacts',
    description: 'Find repeat Genesys Cloud voice contacts over a date range. When ANI is omitted, the tool discovers repeat callers automatically by extracting and normalizing customer-side ANI values from all interactions. When ANI is supplied, the tool finds interactions for that caller. Results are grouped into repeat-contact episodes using a configurable time window and ranked by contact frequency, episode duration, and recency.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description:
            'Start date in YYYY-MM-DD format',
        },
        end_date: {
          type: 'string',
          description:
            'End date in YYYY-MM-DD format. The inclusive range cannot exceed 7 calendar days.',
        },
        ani: {
          type: 'string',
          description:
            'Optional caller ANI. When omitted, the tool discovers repeat callers automatically.',
        },
        minimum_contacts: {
          type: 'number',
          description:
            'Minimum contacts required in a repeat-contact episode. Defaults to 2.',
        },
        repeat_window_hours: {
          type: 'number',
          description:
            'Maximum elapsed time between consecutive contacts in the same repeat episode. Defaults to 72 hours.',
        },
        direction: {
          type: 'string',
          enum: [
            'inbound',
            'outbound',
            'any'
          ],
          description:
            'Conversation direction filter. Defaults to inbound.',
        },
        page_size: {
          type: 'number',
          description:
            'Conversations per analytics page, from 1 to 100. Defaults to 100.',
        },
        max_pages: {
          type: 'number',
          description:
            'Maximum analytics pages to inspect, from 1 to 50. Defaults to 50.',
        },
        max_results: {
          type: 'number',
          description:
            'Maximum callers returned, from 1 to 100. Defaults to 25.',
        },
        include_nonrepeat_contacts: {
          type: 'boolean',
          description:
            'When a specific ANI is supplied, include all contacts even when they do not form a qualifying repeat episode. Defaults to true.',
        },
      },
      required: [
        'start_date',
        'end_date'
      ],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const datePattern =
        /^\d{4}-\d{2}-\d{2}$/;

      if (
        !datePattern.test(
          a.start_date
        ) ||
        !datePattern.test(
          a.end_date
        )
      ) {
        throw new GenesysError(
          'start_date and end_date must use YYYY-MM-DD format.',
          400
        );
      }

      const startDate = new Date(
        `${a.start_date}T00:00:00.000Z`
      );

      const endDate = new Date(
        `${a.end_date}T00:00:00.000Z`
      );

      if (
        Number.isNaN(
          startDate.getTime()
        ) ||
        Number.isNaN(
          endDate.getTime()
        )
      ) {
        throw new GenesysError(
          'start_date or end_date is not a valid date.',
          400
        );
      }

      if (endDate < startDate) {
        throw new GenesysError(
          'end_date must be on or after start_date.',
          400
        );
      }

      const calendarDays =
        Math.floor(
          (
            endDate.getTime() -
            startDate.getTime()
          ) /
          86400000
        ) + 1;

      if (calendarDays > 7) {
        throw new GenesysError(
          'The date range cannot exceed 7 calendar days. Divide larger searches into smaller requests.',
          400
        );
      }

      const minimumContacts =
        Math.max(
          2,
          Math.min(
            100,
            Math.floor(
              Number(
                a.minimum_contacts
              ) || 2
            )
          )
        );

      const repeatWindowHours =
        Math.max(
          0.25,
          Math.min(
            24 * 30,
            Number(
              a.repeat_window_hours
            ) || 72
          )
        );

      const repeatWindowMs =
        repeatWindowHours *
        60 *
        60 *
        1000;

      const direction =
        a.direction || 'inbound';

      const pageSize =
        Math.max(
          1,
          Math.min(
            100,
            Math.floor(
              Number(
                a.page_size
              ) || 100
            )
          )
        );

      const maxPages =
        Math.max(
          1,
          Math.min(
            50,
            Math.floor(
              Number(
                a.max_pages
              ) || 50
            )
          )
        );

      const maxResults =
        Math.max(
          1,
          Math.min(
            100,
            Math.floor(
              Number(
                a.max_results
              ) || 25
            )
          )
        );

      const includeNonrepeatContacts =
        a.include_nonrepeat_contacts !==
        false;

      const interval =
        `${a.start_date}T00:00:00.000Z/` +
        `${a.end_date}T23:59:59.999Z`;

      /*
       * Normalize ANI while avoiding assumptions
       * about international country codes.
       */
      function normalizeAni(
        value
      ) {
        if (
          value === undefined ||
          value === null
        ) {
          return null;
        }

        let text = String(value)
          .trim()
          .toLowerCase();

        if (!text) {
          return null;
        }

        text = text.replace(
          /^(tel:|sip:)/i,
          ''
        );

        /*
         * SIP addresses can contain a phone
         * number before the @ character.
         */
        if (
          text.includes('@')
        ) {
          text =
            text.split('@')[0];
        }

        /*
         * Remove URI parameters.
         */
        text =
          text.split(';')[0];

        const hadLeadingPlus =
          text.startsWith('+');

        const digits =
          text.replace(
            /\D/g,
            ''
          );

        if (!digits) {
          return null;
        }

        /*
         * Normalize North American 10-digit and
         * 11-digit numbers into +1 E.164 form.
         */
        if (
          digits.length === 10
        ) {
          return `+1${digits}`;
        }

        if (
          digits.length === 11 &&
          digits.startsWith('1')
        ) {
          return `+${digits}`;
        }

        /*
         * Preserve international numbers with
         * an explicit leading +.
         */
        if (hadLeadingPlus) {
          return `+${digits}`;
        }

        /*
         * Do not infer a missing country code for
         * non-North-American lengths.
         */
        return digits;
      }

      function timestampMs(
        value
      ) {
        if (!value) {
          return null;
        }

        const result =
          new Date(value).getTime();

        return Number.isFinite(
          result
        )
          ? result
          : null;
      }

      function hoursBetween(
        start,
        end
      ) {
        const startMs =
          timestampMs(start);

        const endMs =
          timestampMs(end);

        if (
          startMs === null ||
          endMs === null ||
          endMs < startMs
        ) {
          return null;
        }

        return Number(
          (
            (
              endMs -
              startMs
            ) /
            3600000
          ).toFixed(2)
        );
      }

      function sessionsFor(
        participant
      ) {
        return Array.isArray(
          participant?.sessions
        )
          ? participant.sessions
          : [];
      }

      function segmentsFor(
        participant
      ) {
        return sessionsFor(
          participant
        ).flatMap(
          (session) =>
            Array.isArray(
              session.segments
            )
              ? session.segments.map(
                  (segment) => ({
                    session,
                    segment,
                  })
                )
              : []
        );
      }

      function purposeOf(
        participant
      ) {
        return String(
          participant?.purpose ||
          ''
        ).toLowerCase();
      }

      function directionMatches(
        conversation,
        participants
      ) {
        if (
          direction === 'any'
        ) {
          return true;
        }

        const directions =
          participants.flatMap(
            (participant) =>
              sessionsFor(
                participant
              )
                .map(
                  (session) =>
                    String(
                      session.direction ||
                      ''
                    ).toLowerCase()
                )
                .filter(Boolean)
          );

        const conversationDirection =
          String(
            conversation.direction ||
            conversation
              .originatingDirection ||
            ''
          ).toLowerCase();

        return (
          directions.includes(
            direction
          ) ||
          conversationDirection ===
            direction
        );
      }

      /*
       * Prefer ANI from the customer/external
       * participant rather than another participant.
       */
      function extractCustomerAni(
        conversation
      ) {
        const participants =
          Array.isArray(
            conversation.participants
          )
            ? conversation.participants
            : [];

        const customers =
          participants.filter(
            (participant) => {
              const purpose =
                purposeOf(
                  participant
                );

              return (
                purpose ===
                  'customer' ||
                purpose ===
                  'external'
              );
            }
          );

        for (
          const participant of
            customers
        ) {
          const candidates = [
            participant.ani,
            participant.address,
            participant
              .externalAddress,
            ...sessionsFor(
              participant
            ).flatMap(
              (session) => [
                session.ani,
                session.address,
                session
                  .remoteNameDisplayable,
              ]
            ),
          ];

          for (
            const candidate of
              candidates
          ) {
            const normalized =
              normalizeAni(
                candidate
              );

            if (normalized) {
              return {
                normalizedAni:
                  normalized,
                originalAni:
                  candidate,
                participantId:
                  participant
                    .participantId ||
                  participant.id ||
                  null,
                participantName:
                  participant
                    .participantName ||
                  participant.name ||
                  null,
                externalContactId:
                  participant
                    .externalContactId ||
                  participant
                    .externalContact
                    ?.id ||
                  null,
              };
            }
          }
        }

        /*
         * Fall back to conversation-level ANI only
         * when customer-participant ANI is absent.
         */
        const fallbackCandidates = [
          conversation.ani,
          conversation
            .externalAddress,
        ];

        for (
          const candidate of
            fallbackCandidates
        ) {
          const normalized =
            normalizeAni(
              candidate
            );

          if (normalized) {
            return {
              normalizedAni:
                normalized,
              originalAni:
                candidate,
              participantId:
                null,
              participantName:
                null,
              externalContactId:
                null,
            };
          }
        }

        return null;
      }

      function uniqueObjectsById(
        items
      ) {
        return [
          ...new Map(
            items
              .filter(
                (item) =>
                  item?.id
              )
              .map(
                (item) => [
                  item.id,
                  item,
                ]
              )
          ).values(),
        ];
      }

      const requestedAni =
        a.ani !== undefined &&
        a.ani !== null &&
        String(a.ani).trim()
          ? normalizeAni(
              a.ani
            )
          : null;

      if (
        a.ani !== undefined &&
        a.ani !== null &&
        String(a.ani).trim() &&
        !requestedAni
      ) {
        throw new GenesysError(
          'ani could not be normalized into a usable phone-number value.',
          400
        );
      }

      const contactsByAni =
        new Map();

      let pagesProcessed = 0;
      let conversationsProcessed =
        0;
      let voiceConversationsProcessed =
        0;
      let conversationsWithoutAni = 0;
      let reachedLastPage = false;
      let reportedTotalHits = null;

      for (
        let pageNumber = 1;
        pageNumber <= maxPages;
        pageNumber++
      ) {
        const result =
          await gc.post(
            '/api/v2/analytics/conversations/details/query',
            {
              interval,
              order: 'asc',
              orderBy:
                'conversationStart',
              paging: {
                pageSize,
                pageNumber,
              },
            }
          );

        if (
          typeof result
            .totalHits ===
            'number' &&
          Number.isFinite(
            result.totalHits
          )
        ) {
          reportedTotalHits =
            result.totalHits;
        }

        const conversations =
          Array.isArray(
            result.conversations
          )
            ? result.conversations
            : [];

        if (
          !conversations.length
        ) {
          reachedLastPage = true;
          break;
        }

        pagesProcessed++;
        conversationsProcessed +=
          conversations.length;

        for (
          const conversation of
            conversations
        ) {
          const participants =
            Array.isArray(
              conversation.participants
            )
              ? conversation.participants
              : [];

          if (
            !directionMatches(
              conversation,
              participants
            )
          ) {
            continue;
          }

          const mediaTypes = [
            ...new Set(
              participants.flatMap(
                (participant) =>
                  sessionsFor(
                    participant
                  )
                    .map(
                      (session) =>
                        String(
                          session.mediaType ||
                          ''
                        ).toLowerCase()
                    )
                    .filter(Boolean)
              )
            ),
          ];

          if (
            !mediaTypes.includes(
              'voice'
            )
          ) {
            continue;
          }

          voiceConversationsProcessed++;

          const caller =
            extractCustomerAni(
              conversation
            );

          if (!caller) {
            conversationsWithoutAni++;
            continue;
          }

          if (
            requestedAni &&
            caller.normalizedAni !==
              requestedAni
          ) {
            continue;
          }

          const conversationId =
            conversation
              .conversationId ||
            conversation.id ||
            null;

          if (!conversationId) {
            continue;
          }

          const allSegments =
            participants.flatMap(
              (participant) =>
                segmentsFor(
                  participant
                ).map(
                  ({
                    session,
                    segment,
                  }) => ({
                    participant,
                    session,
                    segment,
                  })
                )
            );

          const queues =
            uniqueObjectsById(
              allSegments
                .filter(
                  ({
                    segment,
                  }) =>
                    segment.queueId
                )
                .map(
                  ({
                    segment,
                  }) => ({
                    id:
                      segment.queueId,
                    name:
                      segment
                        .queueName ||
                      null,
                  })
                )
            );

          const agents =
            uniqueObjectsById(
              participants
                .filter(
                  (participant) =>
                    purposeOf(
                      participant
                    ) === 'agent'
                )
                .map(
                  (participant) => ({
                    id:
                      participant
                        .userId ||
                      participant
                        .user?.id ||
                      participant
                        .participantId ||
                      null,
                    name:
                      participant
                        .participantName ||
                      participant.name ||
                      null,
                  })
                )
            );

          const wrapUpCodes =
            uniqueObjectsById(
              allSegments
                .filter(
                  ({
                    segment,
                  }) =>
                    segment
                      .wrapUpCode
                )
                .map(
                  ({
                    segment,
                  }) => ({
                    id:
                      segment
                        .wrapUpCode,
                    name:
                      segment
                        .wrapUpCodeName ||
                      null,
                  })
                )
            );

          const disconnectReasons = [
            ...new Set(
              allSegments
                .flatMap(
                  ({
                    segment,
                  }) => [
                    segment
                      .disconnectType,
                    segment
                      .disconnectReason,
                  ]
                )
                .filter(Boolean)
            ),
          ];

          const flows =
            uniqueObjectsById(
              allSegments
                .filter(
                  ({
                    segment,
                  }) =>
                    segment.flowId
                )
                .map(
                  ({
                    segment,
                  }) => ({
                    id:
                      segment.flowId,
                    name:
                      segment
                        .flowName ||
                      null,
                  })
                )
            );

          const startTime =
            conversation
              .conversationStart ||
            null;

          const endTime =
            conversation
              .conversationEnd ||
            null;

          const contact = {
            conversationId,
            normalizedAni:
              caller.normalizedAni,
            originalAni:
              String(
                caller.originalAni
              ),
            externalContactId:
              caller.externalContactId,
            customerParticipantId:
              caller.participantId,
            customerName:
              caller.participantName,
            startTime,
            endTime,
            startTimestamp:
              timestampMs(
                startTime
              ),
            endTimestamp:
              timestampMs(
                endTime
              ),
            mediaTypes,
            queues,
            agents,
            wrapUpCodes,
            flows,
            disconnectReasons,
          };

          if (
            !contactsByAni.has(
              caller.normalizedAni
            )
          ) {
            contactsByAni.set(
              caller.normalizedAni,
              []
            );
          }

          contactsByAni
            .get(
              caller.normalizedAni
            )
            .push(contact);
        }

        if (
          conversations.length <
            pageSize
        ) {
          reachedLastPage = true;
          break;
        }
      }

      /*
       * Build repeat-contact episodes. A contact
       * remains in the same episode when the gap from
       * the previous contact does not exceed the
       * configured repeat window.
       */
      function buildEpisodes(
        contacts
      ) {
        const ordered =
          [...contacts].sort(
            (left, right) =>
              (
                left.startTimestamp ||
                0
              ) -
              (
                right.startTimestamp ||
                0
              )
          );

        const episodes = [];
        let currentEpisode = [];

        for (
          const contact of ordered
        ) {
          if (
            !currentEpisode.length
          ) {
            currentEpisode = [
              contact
            ];
            continue;
          }

          const previous =
            currentEpisode[
              currentEpisode.length -
                1
            ];

          const currentStart =
            contact.startTimestamp;

          const previousStart =
            previous.startTimestamp;

          const gapMs =
            currentStart !== null &&
            previousStart !== null
              ? currentStart -
                previousStart
              : Number
                  .MAX_SAFE_INTEGER;

          if (
            gapMs <= repeatWindowMs
          ) {
            currentEpisode.push(
              contact
            );
          } else {
            episodes.push(
              currentEpisode
            );

            currentEpisode = [
              contact
            ];
          }
        }

        if (
          currentEpisode.length
        ) {
          episodes.push(
            currentEpisode
          );
        }

        return episodes.map(
          (
            episodeContacts,
            index
          ) => {
            const first =
              episodeContacts[0];

            const last =
              episodeContacts[
                episodeContacts.length -
                  1
              ];

            const queueIds = [
              ...new Set(
                episodeContacts
                  .flatMap(
                    (contact) =>
                      contact.queues.map(
                        (queue) =>
                          queue.id
                      )
                  )
              ),
            ];

            const queueNames = [
              ...new Set(
                episodeContacts
                  .flatMap(
                    (contact) =>
                      contact.queues.map(
                        (queue) =>
                          queue.name
                      )
                  )
                  .filter(Boolean)
              ),
            ];

            const agentUserIds = [
              ...new Set(
                episodeContacts
                  .flatMap(
                    (contact) =>
                      contact.agents.map(
                        (agent) =>
                          agent.id
                      )
                  )
                  .filter(Boolean)
              ),
            ];

            const wrapUpCodeIds = [
              ...new Set(
                episodeContacts
                  .flatMap(
                    (contact) =>
                      contact
                        .wrapUpCodes
                        .map(
                          (code) =>
                            code.id
                        )
                  )
              ),
            ];

            return {
              episodeNumber:
                index + 1,
              qualifyingRepeat:
                episodeContacts
                  .length >=
                minimumContacts,
              contactCount:
                episodeContacts.length,
              firstContact:
                first.startTime,
              lastContact:
                last.startTime,
              elapsedHours:
                hoursBetween(
                  first.startTime,
                  last.startTime
                ),
              queueIds,
              queueNames,
              agentUserIds,
              wrapUpCodeIds,
              disconnectReasons: [
                ...new Set(
                  episodeContacts
                    .flatMap(
                      (contact) =>
                        contact
                          .disconnectReasons
                    )
                ),
              ],
              conversationIds:
                episodeContacts.map(
                  (contact) =>
                    contact
                      .conversationId
                ),
              contacts:
                episodeContacts.map(
                  ({
                    startTimestamp:
                      _startTimestamp,
                    endTimestamp:
                      _endTimestamp,
                    ...contact
                  }) => contact
                ),
            };
          }
        );
      }

      const callerResults = [];

      for (
        const [
          normalizedAni,
          contacts,
        ] of contactsByAni
      ) {
        const episodes =
          buildEpisodes(
            contacts
          );

        const qualifyingEpisodes =
          episodes.filter(
            (episode) =>
              episode
                .qualifyingRepeat
          );

        if (
          !requestedAni &&
          !qualifyingEpisodes.length
        ) {
          continue;
        }

        if (
          requestedAni &&
          !qualifyingEpisodes.length &&
          !includeNonrepeatContacts
        ) {
          continue;
        }

        const rankedEpisodes =
          [...qualifyingEpisodes]
            .sort(
              (
                left,
                right
              ) => {
                if (
                  right
                    .contactCount !==
                  left.contactCount
                ) {
                  return (
                    right
                      .contactCount -
                    left
                      .contactCount
                  );
                }

                const leftElapsed =
                  left
                    .elapsedHours ??
                  Number
                    .MAX_SAFE_INTEGER;

                const rightElapsed =
                  right
                    .elapsedHours ??
                  Number
                    .MAX_SAFE_INTEGER;

                if (
                  leftElapsed !==
                  rightElapsed
                ) {
                  return (
                    leftElapsed -
                    rightElapsed
                  );
                }

                return (
                  (
                    timestampMs(
                      right
                        .lastContact
                    ) || 0
                  ) -
                  (
                    timestampMs(
                      left
                        .lastContact
                    ) || 0
                  )
                );
              }
            );

        const topEpisode =
          rankedEpisodes[0] ||
          null;

        const orderedContacts =
          [...contacts].sort(
            (left, right) =>
              (
                left.startTimestamp ||
                0
              ) -
              (
                right.startTimestamp ||
                0
              )
          );

        callerResults.push({
          ani:
            normalizedAni,
          originalAnis: [
            ...new Set(
              contacts.map(
                (contact) =>
                  contact.originalAni
              )
            ),
          ],
          externalContactIds: [
            ...new Set(
              contacts
                .map(
                  (contact) =>
                    contact
                      .externalContactId
                )
                .filter(Boolean)
            ),
          ],
          customerNames: [
            ...new Set(
              contacts
                .map(
                  (contact) =>
                    contact.customerName
                )
                .filter(Boolean)
            ),
          ],
          totalContacts:
            contacts.length,
          repeatEpisodeCount:
            qualifyingEpisodes.length,
          topEpisodeContactCount:
            topEpisode
              ?.contactCount ||
            0,
          topEpisodeElapsedHours:
            topEpisode
              ?.elapsedHours ??
            null,
          mostRecentContact:
            orderedContacts.length
              ? orderedContacts[
                  orderedContacts
                    .length - 1
                ].startTime
              : null,
          qualifyingEpisodes:
            rankedEpisodes,
          allEpisodes:
            requestedAni
              ? episodes
              : undefined,
          allContacts:
            requestedAni &&
            includeNonrepeatContacts
              ? orderedContacts.map(
                  ({
                    startTimestamp:
                      _startTimestamp,
                    endTimestamp:
                      _endTimestamp,
                    ...contact
                  }) => contact
                )
              : undefined,
        });
      }

      /*
       * Most operationally concerning repeat callers
       * appear first:
       * 1. Most contacts in one episode
       * 2. Shortest episode duration
       * 3. Most recent contact
       */
      callerResults.sort(
        (left, right) => {
          if (
            right
              .topEpisodeContactCount !==
            left
              .topEpisodeContactCount
          ) {
            return (
              right
                .topEpisodeContactCount -
              left
                .topEpisodeContactCount
            );
          }

          const leftElapsed =
            left
              .topEpisodeElapsedHours ??
            Number
              .MAX_SAFE_INTEGER;

          const rightElapsed =
            right
              .topEpisodeElapsedHours ??
            Number
              .MAX_SAFE_INTEGER;

          if (
            leftElapsed !==
            rightElapsed
          ) {
            return (
              leftElapsed -
              rightElapsed
            );
          }

          return (
            (
              timestampMs(
                right
                  .mostRecentContact
              ) || 0
            ) -
            (
              timestampMs(
                left
                  .mostRecentContact
              ) || 0
            )
          );
        }
      );

      const returnedCallers =
        callerResults.slice(
          0,
          maxResults
        );

      const truncated =
        !reachedLastPage &&
        pagesProcessed >=
          maxPages;

      return {
        mode:
          requestedAni
            ? 'specific_ani'
            : 'discovery',
        startDate:
          a.start_date,
        endDate:
          a.end_date,
        calendarDays,
        requestedAni:
          requestedAni || null,
        minimumContacts,
        repeatWindowHours,
        direction,
        pageSize,
        maxPages,
        maxResults,
        reportedTotalHits,
        pagesProcessed,
        conversationsProcessed,
        voiceConversationsProcessed,
        conversationsWithoutAni,
        uniqueAnisAnalyzed:
          contactsByAni.size,
        repeatCallersFound:
          callerResults.filter(
            (caller) =>
              caller
                .repeatEpisodeCount >
              0
          ).length,
        callersReturned:
          returnedCallers.length,
        truncated,
        callers:
          returnedCallers,
        traceInstructions:
          returnedCallers.length
            ? 'Use trace_interaction with the returned conversationIds when the user asks why a caller contacted repeatedly or wants to visualize the interaction journeys.'
            : null,
        note:
          truncated
            ? 'The search reached max_pages before confirming the final analytics page. Reduce the date range or divide the search into smaller requests for complete results.'
            : requestedAni
              ? 'The requested ANI was analyzed. allContacts includes nonrepeat interactions when include_nonrepeat_contacts is true.'
              : 'The date range was fully scanned and repeat callers were discovered automatically from customer-side ANI values.',
      };
    },
  },
  
  {
    name: 'list_queues',
    description: 'List routing queues (name, id, division). Optional name_filter supports * wildcards (e.g. "*support*").',
    inputSchema: {
      type: 'object',
      properties: { name_filter: { type: 'string', description: 'Queue name filter, * wildcards allowed' } },
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const r = await gc.listAll('/api/v2/routing/queues', a.name_filter ? { name: a.name_filter } : {});
      return { total: r.total, truncated: r.truncated, queues: r.entities.map((q) => ({ ...slim(q), division: q.division?.name, memberCount: q.memberCount })) };
    },
  },
  {
    name: 'get_queue',
    description: 'Get a queue\'s full configuration (media settings, ACW, routing rules, division) by name or id.',
    inputSchema: {
      type: 'object',
      properties: { queue: { type: 'string', description: 'Queue name or id' } },
      required: ['queue'],
      additionalProperties: false,
    },
    handler: async (gc, a) => gc.get(`/api/v2/routing/queues/${(await resolveOne(gc, 'queue', '/api/v2/routing/queues', a.queue)).id}`),
  },
{
  name: 'update_queue_members',
  description: 'Update membership of an existing Genesys Cloud routing queue. Use this tool whenever users need to be added to or removed from a queue. Only the specifically requested users are changed; all other queue members remain unchanged.',
  inputSchema: {
    type: 'object',
    properties: {
      queue: {
        type: 'string',
        description: 'Queue name or id',
      },
      add: {
        type: 'array',
        items: { type: 'string' },
        description: 'Users to add to the queue, specified by name, email, or id',
      },
      remove: {
        type: 'array',
        items: { type: 'string' },
        description: 'Users to remove from the queue, specified by name, email, or id',
      },
    },
    required: ['queue'],
    additionalProperties: false,
  },

  handler: async (gc, a) => {
    const add = Array.isArray(a.add) ? a.add : [];
    const remove = Array.isArray(a.remove) ? a.remove : [];

    if (!add.length && !remove.length) {
      throw new GenesysError(
        'Provide at least one user in add or remove.',
        400
      );
    }

    const queue = await resolveOne(
      gc,
      'queue',
      '/api/v2/routing/queues',
      a.queue
    );

    const added = [];
    const removed = [];

    // Add requested users
    if (add.length) {
      const usersToAdd = [];

      for (const ref of add) {
        usersToAdd.push(await resolveUser(gc, ref));
      }

      await gc.post(
        `/api/v2/routing/queues/${queue.id}/members`,
        usersToAdd.map((user) => ({
          id: user.id,
        }))
      );

      for (const user of usersToAdd) {
        added.push({
          id: user.id,
          name: user.name,
          email: user.email,
        });
      }
    }

    // Remove requested users
    for (const ref of remove) {
      const user = await resolveUser(gc, ref);

      await gc.api(
        'DELETE',
        `/api/v2/routing/queues/${queue.id}/members/${user.id}`
      );

      removed.push({
        id: user.id,
        name: user.name,
        email: user.email,
      });
    }

    return {
      updated: true,
      queue: queue.name || queue.id,
      queueId: queue.id,
      added,
      removed,
      note: 'Only the requested membership changes were made. Other queue members were left unchanged.',
    };
  },
},
  {
  name: 'list_queue_members',
  description: 'List the users who are members of a Genesys Cloud routing queue.',
  inputSchema: {
    type: 'object',
    properties: {
      queue: {
        type: 'string',
        description: 'Queue name or id'
      }
    },
    required: ['queue'],
    additionalProperties: false,
  },
  handler: async (gc, a) => {
    const queue = await resolveOne(
      gc,
      'queue',
      '/api/v2/routing/queues',
      a.queue
    );

    const r = await gc.listAll(
      `/api/v2/routing/queues/${queue.id}/members`
    );

    return {
      queue: queue.name || queue.id,
      total: r.total,
      members: r.entities.map((m) => ({
        id: m.id,
        name: m.name,
        email: m.email,
        joined: m.joined
      }))
    };
  },
},
  {
    name: 'create_queue',
    description: 'Create a new routing queue. Only name is required; Genesys applies sensible media-setting defaults. Optionally set description, division (name or id), and ACW settings.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        division: { type: 'string', description: 'Division name or id (defaults to Home)' },
        acw_wrapup_prompt: { type: 'string', enum: ['MANDATORY', 'OPTIONAL', 'MANDATORY_TIMEOUT', 'MANDATORY_FORCED_TIMEOUT', 'AGENT_REQUESTED'], description: 'After-call-work mode' },
        acw_timeout_ms: { type: 'number', description: 'ACW timeout in ms (for the timeout modes)' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const body = { name: a.name };
      if (a.description) body.description = a.description;
      if (a.division) body.division = { id: (await resolveOne(gc, 'division', '/api/v2/authorization/divisions', a.division)).id };
      if (a.acw_wrapup_prompt) body.acwSettings = { wrapupPrompt: a.acw_wrapup_prompt, ...(a.acw_timeout_ms ? { timeoutMs: a.acw_timeout_ms } : {}) };
      const q = await gc.post('/api/v2/routing/queues', body);
      return { created: true, id: q.id, name: q.name, division: q.division?.name };
    },
  },
  {
    name: 'list_wrapup_codes',
    description: 'List wrap-up (disposition) codes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (gc) => {
      const r = await gc.listAll('/api/v2/routing/wrapupcodes');
      return { total: r.total, wrapupCodes: r.entities.map(slim) };
    },
  },
  {
    name: 'create_wrapup_code',
    description: 'Create a wrap-up (disposition) code.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const w = await gc.post('/api/v2/routing/wrapupcodes', { name: a.name, ...(a.description ? { description: a.description } : {}) });
      return { created: true, id: w.id, name: w.name };
    },
  },

  // ----- users & skills -----
  {
    name: 'list_users',
    description: 'List users (name, email, state, title). Optional search matches name or email.',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Substring of name or email' } },
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      if (a.search) {
        const res = await gc.post('/api/v2/users/search', { query: [{ fields: ['name', 'email'], value: a.search, type: 'CONTAINS' }], pageSize: 100 });
        return { total: res.total, users: (res.results || []).map((u) => ({ ...slim(u), title: u.title })) };
      }
      const r = await gc.listAll('/api/v2/users', { state: 'active' });
      return { total: r.total, truncated: r.truncated, users: r.entities.map((u) => ({ ...slim(u), title: u.title })) };
    },
  },
  {
    name: 'get_user',
    description: 'Get a user\'s profile and routing skills by email, name, or id.',
    inputSchema: {
      type: 'object',
      properties: { user: { type: 'string', description: 'Email, name, or id' } },
      required: ['user'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const { id } = await resolveUser(gc, a.user);
      const [u, skills] = await Promise.all([
        gc.get(`/api/v2/users/${id}`),
        gc.listAll(`/api/v2/users/${id}/routingskills`),
      ]);
      return {
        id: u.id, name: u.name, email: u.email, state: u.state, title: u.title,
        division: u.division?.name,
        skills: skills.entities.map((s) => ({ name: s.name, proficiency: s.proficiency })),
      };
    },
  },
  {
  name: 'create_user',
  description: 'Create a new Genesys Cloud user. Requires first name, last name, and email address.',
  inputSchema: {
    type: 'object',
    properties: {
      first_name: {
        type: 'string',
        description: 'User first name',
      },
      last_name: {
        type: 'string',
        description: 'User last name',
      },
      email: {
        type: 'string',
        description: 'User email address',
      },
      division: {
  type: 'string',
  description: 'Optional Genesys Cloud division name or id',
},
    },
    required: ['first_name', 'last_name', 'email'],
    additionalProperties: false,
  },

  handler: async (gc, a) => {
    const firstName = a.first_name.trim();
    const lastName = a.last_name.trim();
    const email = a.email.trim().toLowerCase();

    if (!firstName || !lastName || !email) {
      throw new GenesysError(
        'first_name, last_name, and email are required.',
        400
      );
    }

    const user = await gc.post('/api/v2/users', {
      name: `${firstName} ${lastName}`,
      email,
    });
    let division;

if (a.division) {
  division = await resolveOne(
    gc,
    'division',
    '/api/v2/authorization/divisions',
    a.division
  );

  await gc.post(
    `/api/v2/authorization/divisions/${division.id}/objects/USER`,
    [user.id]
  );
}

    return {
      created: true,
      id: user.id,
      name: user.name,
      email: user.email,
      state: user.state,
      division: division?.name,
      divisionId: division?.id,
    };
  },
},
  {
    name: 'list_skills',
    description: 'List ACD routing skills.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (gc) => {
      const r = await gc.listAll('/api/v2/routing/skills');
      return { total: r.total, skills: r.entities.map(slim) };
    },
  },
  {
    name: 'create_skill',
    description: 'Create an ACD routing skill.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const s = await gc.post('/api/v2/routing/skills', { name: a.name });
      return { created: true, id: s.id, name: s.name };
    },
  },
  {
    name: 'assign_user_skill',
    description: 'Assign a routing skill to a user (or update their proficiency, 0-5). Additive only - it does not remove skills.',
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'Email, name, or id' },
        skill: { type: 'string', description: 'Skill name or id' },
        proficiency: { type: 'number', description: '0-5 (default 3)' },
      },
      required: ['user', 'skill'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const [user, skill] = await Promise.all([
        resolveUser(gc, a.user),
        resolveOne(gc, 'skill', '/api/v2/routing/skills', a.skill),
      ]);
      const r = await gc.post(`/api/v2/users/${user.id}/routingskills`, { id: skill.id, proficiency: a.proficiency ?? 3 });
      return { assigned: true, user: user.name || user.id, skill: r.name, proficiency: r.proficiency };
    },
  },
  {
  name: 'update_user_contact_options',
  description: 'Add or update a Genesys Cloud user phone number for Voice, SMS, or both. Preserves all other user addresses. Can optionally apply the directrouting integration tag.',
  inputSchema: {
    type: 'object',
    properties: {
      user: {
        type: 'string',
        description: 'User name, email, or id',
      },
      phone_number: {
        type: 'string',
        description: 'Phone number in E.164 format, for example +15185551212',
      },
      address_type: {
        type: 'string',
        enum: ['WORK', 'WORK2', 'WORK3', 'WORK4', 'MOBILE'],
        description: 'Contact-information slot for the number',
      },
      enable_voice: {
        type: 'boolean',
        description: 'Add or update this number as a Voice address',
      },
      accept_sms: {
        type: 'boolean',
        description: 'Add or update this number as an SMS address',
      },
      country_code: {
        type: 'string',
        description: 'Optional two-letter country code, for example US',
      },
      direct_routing_voice: {
        type: 'boolean',
        description: 'Apply the directrouting integration tag to the Voice address',
      },
      direct_routing_sms: {
        type: 'boolean',
        description: 'Apply the directrouting integration tag to the SMS address',
      },
    },
    required: ['user', 'phone_number', 'address_type'],
    additionalProperties: false,
  },

  handler: async (gc, a) => {
    const userRef = await resolveUser(gc, a.user);
    const userId = pathId('user id', userRef.id);

    const phoneNumber = String(a.phone_number).trim();
    const addressType = String(a.address_type).trim().toUpperCase();
    const enableVoice = a.enable_voice !== false;
    const acceptSms = a.accept_sms === true;

    if (!phoneNumber) {
      throw new GenesysError(
        'phone_number is required.',
        400
      );
    }

    if (!phoneNumber.startsWith('+')) {
      throw new GenesysError(
        'Use an E.164 phone number beginning with + and the country code, for example +15185551212.',
        400
      );
    }

    if (!enableVoice && !acceptSms) {
      throw new GenesysError(
        'At least one of enable_voice or accept_sms must be true.',
        400
      );
    }

    const allowedTypes = [
      'WORK',
      'WORK2',
      'WORK3',
      'WORK4',
      'MOBILE',
    ];

    if (!allowedTypes.includes(addressType)) {
      throw new GenesysError(
        `address_type must be one of: ${allowedTypes.join(', ')}.`,
        400
      );
    }

    const currentUser = await gc.get(
      `/api/v2/users/${userId}`
    );

    const addresses = Array.isArray(currentUser.addresses)
      ? currentUser.addresses.map((address) => ({ ...address }))
      : [];

    const countryCode = a.country_code
      ? String(a.country_code).trim().toUpperCase()
      : undefined;

    function buildAddress(mediaType, directRouting) {
      return {
        address: phoneNumber,
        display: phoneNumber,
        mediaType,
        type: addressType,
        ...(countryCode
          ? { countryCode }
          : {}),
        ...(directRouting
          ? { integration: 'directrouting' }
          : {}),
      };
    }

    function upsertAddress(mediaType, directRouting) {
      let found = false;

      const updated = addresses.map((address) => {
        const sameSlot =
          String(address.mediaType || '').toUpperCase() === mediaType &&
          String(address.type || '').toUpperCase() === addressType;

        if (sameSlot) {
          found = true;

          return {
            ...address,
            ...buildAddress(mediaType, directRouting),
          };
        }

        if (
          directRouting &&
          String(address.mediaType || '').toUpperCase() === mediaType &&
          String(address.integration || '').toLowerCase() ===
            'directrouting'
        ) {
          const copy = { ...address };
          delete copy.integration;
          return copy;
        }

        return address;
      });

      if (!found) {
        updated.push(
          buildAddress(mediaType, directRouting)
        );
      }

      addresses.length = 0;
      addresses.push(...updated);
    }

    if (enableVoice) {
      upsertAddress(
        'PHONE',
        a.direct_routing_voice === true
      );
    }

    if (acceptSms) {
      upsertAddress(
        'SMS',
        a.direct_routing_sms === true
      );
    }

    const updatedUser = await gc.patch(
      `/api/v2/users/${userId}`,
      {
        version: currentUser.version,
        addresses,
      }
    );

    const savedAddresses =
      updatedUser.addresses || addresses;

    const savedVoice = savedAddresses.find(
      (address) =>
        String(address.mediaType || '').toUpperCase() === 'PHONE' &&
        String(address.type || '').toUpperCase() === addressType
    );

    const savedSms = savedAddresses.find(
      (address) =>
        String(address.mediaType || '').toUpperCase() === 'SMS' &&
        String(address.type || '').toUpperCase() === addressType
    );

    return {
      updated: true,
      user:
        updatedUser.name ||
        currentUser.name ||
        userRef.name ||
        userId,
      userId,
      phoneNumber,
      addressType,
      voice: savedVoice
        ? {
            enabled: true,
            integration: savedVoice.integration || null,
          }
        : {
            enabled: false,
          },
      sms: savedSms
        ? {
            enabled: true,
            integration: savedSms.integration || null,
          }
        : {
            enabled: false,
          },
      note: 'Existing addresses were preserved. Voice and SMS are stored as separate Genesys Cloud address entries.',
    };
  },
},
  {
  name: 'set_user_direct_routing_tag',
  description: 'Add or remove the Genesys Cloud directrouting integration tag on one existing user phone, SMS, or email address. Use this tool whenever a user address must be enabled or disabled for direct routing. The tool preserves all existing user addresses and enforces only one directrouting tag per media type.',
  inputSchema: {
    type: 'object',
    properties: {
      user: {
        type: 'string',
        description: 'User name, email, or id',
      },
      media_type: {
        type: 'string',
        enum: ['PHONE', 'SMS', 'EMAIL'],
        description: 'Media type of the address being tagged',
      },
      address: {
        type: 'string',
        description: 'Exact phone number, SMS number, or email address to update',
      },
      action: {
        type: 'string',
        enum: ['add', 'remove'],
        description: 'Add or remove the directrouting integration tag. Defaults to add.',
      },
    },
    required: ['user', 'media_type', 'address'],
    additionalProperties: false,
  },

  handler: async (gc, a) => {
    const userRef = await resolveUser(gc, a.user);
    const userId = pathId('user id', userRef.id);

    const mediaType = String(a.media_type).trim().toUpperCase();
    const targetAddress = String(a.address).trim();
    const action = a.action || 'add';

    if (!targetAddress) {
      throw new GenesysError('address is required.', 400);
    }

    const currentUser = await gc.get(`/api/v2/users/${userId}`);
    const addresses = Array.isArray(currentUser.addresses)
      ? currentUser.addresses.map((address) => ({ ...address }))
      : [];

    if (!addresses.length) {
      throw new GenesysError(
        `User "${currentUser.name || userRef.name || userId}" has no addresses to update.`,
        404
      );
    }

    const normalizedTarget = targetAddress.toLowerCase();

    const matches = addresses.filter((address) => {
      if (String(address.mediaType || '').toUpperCase() !== mediaType) {
        return false;
      }

      const values = [
        address.address,
        address.display,
        address.extension,
      ]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => String(value).trim().toLowerCase());

      return values.includes(normalizedTarget);
    });

    if (!matches.length) {
      const available = addresses
        .filter(
          (address) =>
            String(address.mediaType || '').toUpperCase() === mediaType
        )
        .map(
          (address) =>
            `${address.type || 'unknown'}: ${
              address.address ||
              address.display ||
              address.extension ||
              'no value'
            }`
        );

      throw new GenesysError(
        `No ${mediaType} address exactly matching "${targetAddress}" was found for ${
          currentUser.name || userId
        }. Available ${mediaType} addresses: ${
          available.length ? available.join(', ') : 'none'
        }.`,
        404
      );
    }

    if (matches.length > 1) {
      throw new GenesysError(
        `More than one ${mediaType} address matched "${targetAddress}". Use an exact unique address.`,
        409
      );
    }

    const target = matches[0];

    const updatedAddresses = addresses.map((address) => {
      const isSameMedia =
        String(address.mediaType || '').toUpperCase() === mediaType;

      const isTarget = address === target;

      if (action === 'add' && isSameMedia) {
        if (isTarget) {
          return {
            ...address,
            integration: 'directrouting',
          };
        }

        if (
          String(address.integration || '').toLowerCase() ===
          'directrouting'
        ) {
          const copy = { ...address };
          delete copy.integration;
          return copy;
        }
      }

      if (
        action === 'remove' &&
        isTarget &&
        String(address.integration || '').toLowerCase() ===
          'directrouting'
      ) {
        const copy = { ...address };
        delete copy.integration;
        return copy;
      }

      return address;
    });

    const updatedUser = await gc.patch(
      `/api/v2/users/${userId}`,
      {
        version: currentUser.version,
        addresses: updatedAddresses,
      }
    );

    const updatedTarget = (updatedUser.addresses || updatedAddresses).find(
      (address) => {
        if (
          String(address.mediaType || '').toUpperCase() !== mediaType
        ) {
          return false;
        }

        return [
          address.address,
          address.display,
          address.extension,
        ]
          .filter((value) => value !== undefined && value !== null)
          .map((value) => String(value).trim().toLowerCase())
          .includes(normalizedTarget);
      }
    );

    return {
      updated: true,
      action,
      user: updatedUser.name || currentUser.name || userRef.name || userId,
      userId,
      mediaType,
      address:
        updatedTarget?.address ||
        updatedTarget?.display ||
        updatedTarget?.extension ||
        targetAddress,
      addressType: updatedTarget?.type || target.type,
      integration: updatedTarget?.integration || null,
      note:
        action === 'add'
          ? `The directrouting tag was assigned to the selected ${mediaType} address. Any previous directrouting tag on another ${mediaType} address was removed.`
          : `The directrouting tag was removed from the selected ${mediaType} address.`,
    };
  },
},
  {
  name: 'remove_user_skill',
  description: 'Remove a routing skill from a user. Removes only the specified skill and leaves all other skills unchanged.',
  inputSchema: {
    type: 'object',
    properties: {
      user: { type: 'string', description: 'Email, name, or id' },
      skill: { type: 'string', description: 'Skill name or id' },
    },
    required: ['user', 'skill'],
    additionalProperties: false,
  },
  handler: async (gc, a) => {
    const [user, skill] = await Promise.all([
      resolveUser(gc, a.user),
      resolveOne(gc, 'skill', '/api/v2/routing/skills', a.skill),
    ]);

    await gc.api(
      'DELETE',
      `/api/v2/users/${user.id}/routingskills/${skill.id}`
    );

    return {
      removed: true,
      user: user.name || user.id,
      skill: skill.name || skill.id,
    };
  },
},

    {
    name: 'update_group_users',
    description: 'Add or remove owners and members of an existing Genesys Cloud group. Only the requested changes are made. Users added as owners are automatically added as members first. Users removed as both owners and members are removed as owners first.',
    inputSchema: {
      type: 'object',
      properties: {
        group: {
          type: 'string',
          description: 'Genesys Cloud group name or id',
        },
        add_owners: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Users to add as group owners, specified by name, email, or id',
        },
        remove_owners: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Users to remove as group owners, specified by name, email, or id',
        },
        add_members: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Users to add as group members, specified by name, email, or id',
        },
        remove_members: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Users to remove as group members, specified by name, email, or id',
        },
      },
      required: ['group'],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const addOwnerRefs = Array.isArray(
        a.add_owners
      )
        ? a.add_owners
        : [];

      const removeOwnerRefs = Array.isArray(
        a.remove_owners
      )
        ? a.remove_owners
        : [];

      const addMemberRefs = Array.isArray(
        a.add_members
      )
        ? a.add_members
        : [];

      const removeMemberRefs = Array.isArray(
        a.remove_members
      )
        ? a.remove_members
        : [];

      if (
        !addOwnerRefs.length &&
        !removeOwnerRefs.length &&
        !addMemberRefs.length &&
        !removeMemberRefs.length
      ) {
        throw new GenesysError(
          'Provide at least one user in add_owners, remove_owners, add_members, or remove_members.',
          400
        );
      }

      const groupRef = await resolveOne(
        gc,
        'group',
        '/api/v2/groups',
        a.group
      );

      const groupId = pathId(
        'group id',
        groupRef.id
      );

      const group = await gc.get(
        `/api/v2/groups/${groupId}`
      );

      async function resolveUsers(refs) {
        const users = [];

        for (const ref of refs) {
          users.push(
            await resolveUser(gc, ref)
          );
        }

        return [
          ...new Map(
            users.map((user) => [
              user.id,
              user,
            ])
          ).values(),
        ];
      }

      const [
        addOwners,
        removeOwners,
        addMembers,
        removeMembers,
      ] = await Promise.all([
        resolveUsers(addOwnerRefs),
        resolveUsers(removeOwnerRefs),
        resolveUsers(addMemberRefs),
        resolveUsers(removeMemberRefs),
      ]);

      const addOwnerIds = new Set(
        addOwners.map((user) => user.id)
      );

      const removeOwnerIds = new Set(
        removeOwners.map((user) => user.id)
      );

      const addMemberIds = new Set(
        addMembers.map((user) => user.id)
      );

      const removeMemberIds = new Set(
        removeMembers.map(
          (user) => user.id
        )
      );

      function overlappingIds(
        first,
        second
      ) {
        return [...first].filter((id) =>
          second.has(id)
        );
      }

      const ownerConflicts =
        overlappingIds(
          addOwnerIds,
          removeOwnerIds
        );

      if (ownerConflicts.length) {
        throw new GenesysError(
          'The same user cannot appear in both add_owners and remove_owners.',
          400
        );
      }

      const memberConflicts =
        overlappingIds(
          addMemberIds,
          removeMemberIds
        );

      if (memberConflicts.length) {
        throw new GenesysError(
          'The same user cannot appear in both add_members and remove_members.',
          400
        );
      }

      const addOwnerRemoveMemberConflicts =
        overlappingIds(
          addOwnerIds,
          removeMemberIds
        );

      if (
        addOwnerRemoveMemberConflicts.length
      ) {
        throw new GenesysError(
          'A user cannot be added as an owner and removed as a member in the same request.',
          400
        );
      }

const currentOwnerIds = new Set(
  (group.owners || [])
    .map(
      (owner) =>
        owner.id ||
        owner.userId
    )
    .filter(Boolean)
);

const currentMembersResult =
  await gc.listAll(
    `/api/v2/groups/${groupId}/members`
  );

const currentMembers =
  Array.isArray(
    currentMembersResult.entities
  )
    ? currentMembersResult.entities
    : [];

const currentMemberIds = new Set(
  currentMembers
          .map(
            (member) =>
              member.id ||
              member.userId
          )
          .filter(Boolean)
      );

      /*
       * Owners must also be group members.
       * Add requested owners to the membership set first.
       */
      const membershipIdsToAdd =
        new Set([
          ...addMemberIds,
          ...addOwnerIds,
        ]);

      const actualMemberIdsToAdd = [
        ...membershipIdsToAdd,
      ].filter(
        (id) =>
          !currentMemberIds.has(id)
      );

      const desiredOwnerIds =
        new Set(currentOwnerIds);

      for (const id of addOwnerIds) {
        desiredOwnerIds.add(id);
      }

      for (const id of removeOwnerIds) {
        desiredOwnerIds.delete(id);
      }

      if (
        currentOwnerIds.size > 0 &&
        desiredOwnerIds.size === 0
      ) {
        throw new GenesysError(
          'This request would remove every owner from the group. Add or retain at least one owner.',
          400
        );
      }

      /*
       * A current or newly added owner cannot be removed
       * from group membership unless ownership is also
       * removed in this request.
       */
      const invalidOwnerMemberRemovals = [
        ...removeMemberIds,
      ].filter(
        (id) =>
          desiredOwnerIds.has(id)
      );

      if (
        invalidOwnerMemberRemovals.length
      ) {
        throw new GenesysError(
          'A group owner cannot be removed from membership while remaining an owner. Put the user in remove_owners as well.',
          400
        );
      }

      const actualMemberIdsToRemove = [
        ...removeMemberIds,
      ].filter((id) =>
        currentMemberIds.has(id)
      );

      const addedMembers = [];
      const removedMembers = [];
      const addedOwners = [];
      const removedOwners = [];
      const unchanged = [];

      function userResult(user) {
        return {
          id: user.id,
          name: user.name || null,
          email: user.email || null,
        };
      }

      /*
       * Step 1:
       * Add required memberships before adding ownership.
       */
      if (actualMemberIdsToAdd.length) {
        await gc.post(
          `/api/v2/groups/${groupId}/members`,
          {
            memberIds:
              actualMemberIdsToAdd,
          }
        );

        for (const user of [
          ...addMembers,
          ...addOwners,
        ]) {
          if (
            actualMemberIdsToAdd.includes(
              user.id
            ) &&
            !addedMembers.some(
              (item) =>
                item.id === user.id
            )
          ) {
            addedMembers.push(
              userResult(user)
            );
          }
        }
      }

      for (const user of addMembers) {
        if (
          currentMemberIds.has(user.id)
        ) {
          unchanged.push({
            ...userResult(user),
            role: 'member',
            reason:
              'User was already a group member.',
          });
        }
      }

      /*
       * Step 2:
       * Update the complete owner set while preserving
       * the rest of the group configuration.
       */
      const ownersChanged =
        [...desiredOwnerIds].some(
          (id) =>
            !currentOwnerIds.has(id)
        ) ||
        [...currentOwnerIds].some(
          (id) =>
            !desiredOwnerIds.has(id)
        );

      if (ownersChanged) {
        const updateBody = {
          name: group.name,
          ownerIds: [
            ...desiredOwnerIds,
          ],
        };

        if (
          group.state !== undefined
        ) {
          updateBody.state =
            group.state;
        }

        if (
          group.rules !== undefined
        ) {
          updateBody.rules =
            group.rules;
        }

        if (
          group.type !== undefined
        ) {
          updateBody.type =
            group.type;
        }

       await gc.api(
  'PUT',
  `/api/v2/groups/${groupId}`,
  {
    body: updateBody,
  }
);
      }

      for (const user of addOwners) {
        if (
          !currentOwnerIds.has(user.id)
        ) {
          addedOwners.push(
            userResult(user)
          );
        } else {
          unchanged.push({
            ...userResult(user),
            role: 'owner',
            reason:
              'User was already a group owner.',
          });
        }
      }

      for (
        const user of removeOwners
      ) {
        if (
          currentOwnerIds.has(user.id)
        ) {
          removedOwners.push(
            userResult(user)
          );
        } else {
          unchanged.push({
            ...userResult(user),
            role: 'owner',
            reason:
              'User was not a group owner.',
          });
        }
      }

      /*
       * Step 3:
       * Remove memberships only after ownership has
       * been removed.
       */
      if (
        actualMemberIdsToRemove.length
      ) {
        await gc.api(
          'DELETE',
          `/api/v2/groups/${groupId}/members`,
          {
            query: {
              ids:
                actualMemberIdsToRemove.join(
                  ','
                ),
            },
          }
        );

        for (
          const user of removeMembers
        ) {
          if (
            actualMemberIdsToRemove.includes(
              user.id
            )
          ) {
            removedMembers.push(
              userResult(user)
            );
          }
        }
      }

      for (
        const user of removeMembers
      ) {
        if (
          !currentMemberIds.has(user.id)
        ) {
          unchanged.push({
            ...userResult(user),
            role: 'member',
            reason:
              'User was not a group member.',
          });
        }
      }

      /*
       * Verify the saved group configuration.
       */
      const updatedGroup = await gc.get(
        `/api/v2/groups/${groupId}`
      );

      const finalOwnerIds = (
        updatedGroup.owners || []
      )
        .map(
          (owner) =>
            owner.id ||
            owner.userId
        )
        .filter(Boolean);

      return {
        updated: true,
        group:
          updatedGroup.name ||
          group.name ||
          groupId,
        groupId,
        addedOwners,
        removedOwners,
        addedMembers,
        removedMembers,
        unchanged,
        finalOwnerIds,
        note:
          'Only the requested owner and membership changes were made. Users added as owners were added as members first. Users removed as both owners and members were removed as owners first.',
      };
    },
  },
  
  // ----- flows (Architect) -----
  {
    name: 'list_flows',
    description: 'List Architect flows (name, type, published state). Optional type filter, e.g. inboundcall, inboundchat, inboundemail, bot, digitalbot, workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Flow type filter (e.g. "inboundcall")' },
        name_filter: { type: 'string', description: 'Flow name filter, * wildcards allowed' },
      },
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const query = {};
      if (a.type) query.type = a.type;
      if (a.name_filter) query.name = a.name_filter;
      const r = await gc.listAll('/api/v2/flows', query);
      return {
        total: r.total, truncated: r.truncated,
        flows: r.entities.map((f) => ({
          id: f.id, name: f.name, type: f.type, division: f.division?.name,
          published: Boolean(f.publishedVersion), publishedVersion: f.publishedVersion?.id,
          checkedInVersion: f.checkedInVersion?.id, active: f.active,
        })),
      };
    },
  },
  {
    name: 'get_flow',
    description: 'Get a flow\'s metadata (type, versions, division, description) by name or id.',
    inputSchema: {
      type: 'object',
      properties: { flow: { type: 'string', description: 'Flow name or id' } },
      required: ['flow'],
      additionalProperties: false,
    },
    handler: async (gc, a) => gc.get(`/api/v2/flows/${(await resolveOne(gc, 'flow', '/api/v2/flows', a.flow)).id}`),
  },
  {
    name: 'get_flow_configuration',
    description: 'Get a flow\'s latest full configuration JSON (the actual flow logic: actions, menus, transfers). Large output - use for inspecting or rendering a specific flow. Secret-looking values (secret-named fields, and the value next to a secret-looking variable name) are replaced with [redacted].',
    inputSchema: {
      type: 'object',
      properties: { flow: { type: 'string', description: 'Flow name or id' } },
      required: ['flow'],
      additionalProperties: false,
    },
    // Secret-named keys and { name: "apiKey", value: "..." } pairs are redacted.
    handler: async (gc, a) => redactNamedValues(redactSecrets(await gc.get(`/api/v2/flows/${(await resolveOne(gc, 'flow', '/api/v2/flows', a.flow)).id}/latestconfiguration`))),
  },
  {
    name: 'list_prompts',
    description: 'List Architect user prompts (reusable audio/TTS prompts).',
    inputSchema: {
      type: 'object',
      properties: { name_filter: { type: 'string', description: 'Prompt name filter' } },
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const r = await gc.listAll('/api/v2/architect/prompts', a.name_filter ? { name: a.name_filter } : {});
      return { total: r.total, prompts: r.entities.map((p) => ({ id: p.id, name: p.name, description: p.description })) };
    },
  },
  {
    name: 'list_flow_outcomes',
    description: 'List Genesys Cloud Architect flow outcomes. Flow outcomes are reusable business-result objects that can be initialized and set to success or failure inside Architect flows.',
    inputSchema: {
      type: 'object',
      properties: {
        name_filter: {
          type: 'string',
          description: 'Optional outcome name filter. Matching is performed case-insensitively against the returned outcomes.',
        },
      },
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const result =
        await gc.listAll(
          '/api/v2/flows/outcomes'
        );

      let outcomes =
        Array.isArray(
          result.entities
        )
          ? result.entities
          : [];

      if (
        a.name_filter &&
        String(
          a.name_filter
        ).trim()
      ) {
        const filter =
          String(
            a.name_filter
          )
            .trim()
            .toLowerCase();

        outcomes =
          outcomes.filter(
            (outcome) =>
              String(
                outcome.name || ''
              )
                .toLowerCase()
                .includes(filter)
          );
      }

      return {
        total:
          outcomes.length,
        truncated:
          result.truncated ||
          false,
        outcomes:
          outcomes.map(
            (outcome) => ({
              id:
                outcome.id,
              name:
                outcome.name,
              description:
                outcome.description ||
                null,
              divisionId:
                outcome.division?.id ||
                outcome.divisionId ||
                null,
              divisionName:
                outcome.division?.name ||
                null,
              dateCreated:
                outcome.dateCreated ||
                null,
              dateModified:
                outcome.dateModified ||
                null,
            })
          ),
      };
    },
  },
    {
    name: 'create_flow_outcome',
    description: 'Create a reusable Genesys Cloud Architect flow outcome. The outcome can later be referenced by Architect Initialize Flow Outcome and Set Flow Outcome actions. If an outcome with the same exact name already exists, the tool returns the existing outcome instead of creating a duplicate.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Flow outcome name',
        },
        description: {
          type: 'string',
          description: 'Optional description explaining the business result measured by this outcome',
        },
        division: {
          type: 'string',
          description: 'Optional Genesys Cloud division name or id',
        },
      },
      required: [
        'name',
      ],
      additionalProperties: false,
    },

    handler: async (gc, a) => {
      const name = String(
        a.name || ''
      ).trim();

      if (!name) {
        throw new GenesysError(
          'name is required.',
          400
        );
      }

      /*
       * Outcomes cannot be deleted in the normal
       * lifecycle, so avoid creating accidental
       * duplicates.
       */
      const existingResult =
        await gc.listAll(
          '/api/v2/flows/outcomes'
        );

      const existingOutcomes =
        Array.isArray(
          existingResult.entities
        )
          ? existingResult.entities
          : [];

      const existing =
        existingOutcomes.find(
          (outcome) =>
            String(
              outcome.name || ''
            )
              .trim()
              .toLowerCase() ===
            name.toLowerCase()
        );

      if (existing) {
        return {
          created:
            false,
          existing:
            true,
          id:
            existing.id,
          name:
            existing.name,
          description:
            existing.description ||
            null,
          divisionId:
            existing.division?.id ||
            existing.divisionId ||
            null,
          divisionName:
            existing.division?.name ||
            null,
          note:
            'A flow outcome with this exact name already exists. No duplicate was created.',
        };
      }

      const body = {
        name,
      };

      if (
        a.description &&
        String(
          a.description
        ).trim()
      ) {
        body.description =
          String(
            a.description
          ).trim();
      }

      let division = null;

      if (
        a.division &&
        String(
          a.division
        ).trim()
      ) {
        division =
          await resolveOne(
            gc,
            'division',
            '/api/v2/authorization/divisions',
            String(
              a.division
            ).trim()
          );

        body.division = {
          id:
            division.id,
        };
      }

      const outcome =
        await gc.post(
          '/api/v2/flows/outcomes',
          body
        );

      return {
        created:
          true,
        existing:
          false,
        id:
          outcome.id,
        name:
          outcome.name ||
          name,
        description:
          outcome.description ||
          body.description ||
          null,
        divisionId:
          outcome.division?.id ||
          outcome.divisionId ||
          division?.id ||
          null,
        divisionName:
          outcome.division?.name ||
          division?.name ||
          null,
        note:
          'Flow outcome created. It can now be referenced by Architect flow outcome actions.',
      };
    },
  },
  // ----- schedules & hours -----
  {
    name: 'list_schedules',
    description: 'List Architect schedules and schedule groups (the org objects that power business-hours branching in flows).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (gc) => {
      const [schedules, groups] = await Promise.all([
        gc.listAll('/api/v2/architect/schedules'),
        gc.listAll('/api/v2/architect/schedulegroups'),
      ]);
      return {
        schedules: schedules.entities.map((s) => ({ id: s.id, name: s.name, start: s.start, end: s.end, rrule: s.rrule })),
        scheduleGroups: groups.entities.map((g) => ({ id: g.id, name: g.name, timeZone: g.timeZone, open: g.openSchedules?.map((x) => x.name ?? x.id), closed: g.closedSchedules?.map((x) => x.name ?? x.id) })),
      };
    },
  },
  {
    name: 'create_schedule',
    description: 'Create a weekly recurring Architect schedule (e.g. business hours Mon-Fri 08:00-17:00). days uses two-letter codes: MO TU WE TH FR SA SU. Combine schedules into a group with create_schedule_group; flows branch on the GROUP.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        days: { type: 'array', items: { type: 'string', enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] }, description: 'Days this schedule is active' },
        start_time: { type: 'string', description: 'Daily start, 24h HH:MM (e.g. "08:00")' },
        end_time: { type: 'string', description: 'Daily end, 24h HH:MM (e.g. "17:00")' },
      },
      required: ['name', 'days', 'start_time', 'end_time'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const t = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
      if (!t(a.start_time) || !t(a.end_time)) throw new GenesysError('start_time/end_time must be 24h HH:MM', 400);
      if (!a.days.length) throw new GenesysError('days must be non-empty', 400);
      // The series anchor date must fall on a day the rrule includes, so pick
      // the first selected day within a known past week (2026-01-05 = Monday).
      const anchor = { MO: '05', TU: '06', WE: '07', TH: '08', FR: '09', SA: '10', SU: '11' }[a.days[0]];
      const s = await gc.post('/api/v2/architect/schedules', {
        name: a.name,
        start: `2026-01-${anchor}T${a.start_time}:00.000`,
        end: `2026-01-${anchor}T${a.end_time}:00.000`,
        rrule: `FREQ=WEEKLY;INTERVAL=1;BYDAY=${a.days.join(',')}`,
      });
      return { created: true, id: s.id, name: s.name, rrule: s.rrule };
    },
  },
  {
    name: 'create_schedule_group',
    description: 'Create an Architect schedule group (what flows actually branch on): a time zone plus open/closed/holiday schedules referenced by name or id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        time_zone: { type: 'string', description: 'IANA time zone, e.g. "America/New_York"' },
        open_schedules: { type: 'array', items: { type: 'string' }, description: 'Schedule names or ids for open hours' },
        closed_schedules: { type: 'array', items: { type: 'string' }, description: 'Optional: explicit closed schedules' },
        holiday_schedules: { type: 'array', items: { type: 'string' }, description: 'Optional: holiday schedules' },
      },
      required: ['name', 'time_zone', 'open_schedules'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      // The architect schedules endpoint does not filter by name reliably, so
      // resolve client-side from the full list (with one retry for the brief
      // consistency lag after a create).
      const resolve = async (ref) => {
        if (GUID_RE.test(ref)) return { id: ref };
        for (let attempt = 0; attempt < 2; attempt++) {
          const { entities } = await gc.listAll('/api/v2/architect/schedules');
          const m = entities.filter((s) => s.name?.toLowerCase() === ref.toLowerCase());
          if (m.length === 1) return { id: m[0].id };
          if (m.length > 1) throw new GenesysError(`Ambiguous schedule "${ref}" - use the id.`, 409);
          await new Promise((r) => setTimeout(r, 2500));
        }
        throw new GenesysError(`No schedule found matching "${ref}"`, 404);
      };
      const g = await gc.post('/api/v2/architect/schedulegroups', {
        name: a.name,
        timeZone: a.time_zone,
        openSchedules: await Promise.all(a.open_schedules.map(resolve)),
        ...(a.closed_schedules?.length ? { closedSchedules: await Promise.all(a.closed_schedules.map(resolve)) } : {}),
        ...(a.holiday_schedules?.length ? { holidaySchedules: await Promise.all(a.holiday_schedules.map(resolve)) } : {}),
      });
      return { created: true, id: g.id, name: g.name, timeZone: g.timeZone };
    },
  },

  // ----- org & telephony -----
  {
    name: 'list_divisions',
    description: 'List authorization divisions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (gc) => {
      const r = await gc.listAll('/api/v2/authorization/divisions');
      return { total: r.total, divisions: r.entities.map((d) => ({ id: d.id, name: d.name, home: d.homeDivision })) };
    },
  },
  {
    name: 'list_did_pools',
    description: 'List DID number pools (phone number ranges available in the org).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (gc) => {
      const r = await gc.listAll('/api/v2/telephony/providers/edges/didpools');
      return { total: r.total, didPools: r.entities.map((p) => ({ id: p.id, startPhoneNumber: p.startPhoneNumber, endPhoneNumber: p.endPhoneNumber, provider: p.provider })) };
    },
  },
  // ----- outbound (lists, campaigns, cadences) -----
  {
    name: 'list_contact_lists',
    description: 'List outbound contact lists (name, size, columns, attached attempt limits). Optional name_filter supports * wildcards.',
    inputSchema: {
      type: 'object',
      properties: { name_filter: { type: 'string', description: 'Contact list name filter, * wildcards allowed' } },
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const r = await gc.listAll('/api/v2/outbound/contactlists', { includeSize: true, ...(a.name_filter ? { name: a.name_filter } : {}) });
      return {
        total: r.total, truncated: r.truncated,
        contactLists: r.entities.map((l) => ({
          id: l.id, name: l.name, size: l.size, columns: l.columnNames,
          phoneColumns: l.phoneColumns?.map((p) => `${p.columnName} (${p.type})`),
          attemptLimits: l.attemptLimits?.name, division: l.division?.name,
        })),
      };
    },
  },
  {
    name: 'get_contact_list',
    description: 'Get a contact list\'s full configuration (columns, phone columns, attempt limits, time zone mapping) by name or id.',
    inputSchema: {
      type: 'object',
      properties: { contact_list: { type: 'string', description: 'Contact list name or id' } },
      required: ['contact_list'],
      additionalProperties: false,
    },
    handler: async (gc, a) => gc.get(`/api/v2/outbound/contactlists/${(await resolveOne(gc, 'contact list', '/api/v2/outbound/contactlists', a.contact_list)).id}`, { includeSize: true }),
  },
  {
    name: 'create_contact_list',
    description: 'Create an outbound contact list: name, columns (e.g. ["first_name","phone","zip"]), and phone_columns marking which columns hold numbers. Compliance windows come from ONE of: zip_column (automatic local-time-zone mapping; excludes campaign callable time sets) or time_zone_column (a column of IANA zones per contact, REQUIRED for campaigns with a callable time set, and impossible to add later). Optionally attach attempt_limits. Add rows afterwards with add_contacts.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Column names for the list' },
        phone_columns: {
          type: 'array',
          items: { type: 'object', properties: { column: { type: 'string' }, type: { type: 'string', description: 'cell | home | work | voice | other (default cell)' } }, required: ['column'], additionalProperties: false },
          description: 'Which columns hold phone numbers',
        },
        attempt_limits: { type: 'string', description: 'Attempt limits name or id to attach (see create_attempt_limits)' },
        zip_column: { type: 'string', description: 'Column holding ZIP codes; enables automatic time zone mapping' },
        automatic_time_zone_mapping: { type: 'boolean', description: 'Override the zip_column default' },
        time_zone_column: { type: 'string', description: 'Column holding each contact\'s IANA time zone (e.g. America/New_York); required to use callable time sets' },
        division: { type: 'string', description: 'Division name or id' },
      },
      required: ['name', 'columns', 'phone_columns'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const body = composeContactList(a);
      if (a.attempt_limits) body.attemptLimits = { id: (await resolveOne(gc, 'attempt limits', '/api/v2/outbound/attemptlimits', a.attempt_limits)).id };
      if (a.division) body.division = { id: (await resolveOne(gc, 'division', '/api/v2/authorization/divisions', a.division)).id };
      const l = await gc.post('/api/v2/outbound/contactlists', body);
      return { created: true, id: l.id, name: l.name, columns: l.columnNames, phoneColumns: l.phoneColumns, attemptLimits: l.attemptLimits?.name, automaticTimeZoneMapping: l.automaticTimeZoneMapping };
    },
  },
  {
    name: 'add_contacts',
    description: 'Add contacts to a contact list (max 50 per call). Each contact is a flat object of column -> value matching the list\'s columns; phone values as E.164 or 10-digit. CAUTION: contacts added to a list that a RUNNING campaign is dialing will be called - confirm the target list with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        contact_list: { type: 'string', description: 'Contact list name or id' },
        contacts: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Rows: { column: value, ... }' },
        callable: { type: 'boolean', description: 'Whether the new contacts are dialable (default true)' },
      },
      required: ['contact_list', 'contacts'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      if (!Array.isArray(a.contacts) || !a.contacts.length) throw new GenesysError('contacts must be a non-empty array', 400);
      if (a.contacts.length > 50) throw new GenesysError('Max 50 contacts per call - send the rest in another call', 400);
      const list = await resolveOne(gc, 'contact list', '/api/v2/outbound/contactlists', a.contact_list);
      const body = a.contacts.map((c) => ({
        contactListId: list.id,
        data: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v)])),
        callable: a.callable !== false,
      }));
      const r = await gc.post(`/api/v2/outbound/contactlists/${list.id}/contacts`, body);
      return { added: Array.isArray(r) ? r.length : a.contacts.length, contactList: list.name || list.id };
    },
  },
  {
    name: 'create_attempt_limits',
    description: 'Create an attempt-limits object: the retry cadence for a contact list (max attempts per contact/number, and per-outcome recalls like "no_answer: retry twice, 240 minutes apart"). Attach it to a contact list via create_contact_list. Recall reasons: busy, no_answer, answering_machine, disconnect, fax.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        max_attempts_per_contact: { type: 'number', description: 'Default 3' },
        max_attempts_per_number: { type: 'number' },
        time_zone: { type: 'string', description: 'IANA time zone the daily counters reset in (default America/New_York)' },
        reset_period: { type: 'string', enum: ['NEVER', 'TODAY'], description: 'When attempt counts reset (default NEVER)' },
        recalls: {
          type: 'object',
          description: 'Per-outcome retry rules, e.g. { "no_answer": { "attempts": 2, "minutes_between": 240 } }',
          additionalProperties: { type: 'object', properties: { attempts: { type: 'number' }, minutes_between: { type: 'number' } }, additionalProperties: false },
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const al = await gc.post('/api/v2/outbound/attemptlimits', composeAttemptLimits(a));
      return { created: true, id: al.id, name: al.name, maxAttemptsPerContact: al.maxAttemptsPerContact, recallEntries: al.recallEntries };
    },
  },
  {
    name: 'create_callable_time_set',
    description: 'Create a callable time set: the compliance calling windows a campaign may dial in (e.g. Mon-Fri 09:00-19:00 Eastern). days uses two-letter codes MO TU WE TH FR SA SU; times are 24h HH:MM. Attach to campaigns via create_campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        windows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              days: { type: 'array', items: { type: 'string', enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] } },
              start_time: { type: 'string', description: '24h HH:MM' },
              end_time: { type: 'string', description: '24h HH:MM' },
              time_zone: { type: 'string', description: 'IANA time zone (default America/New_York)' },
            },
            required: ['days', 'start_time', 'end_time'],
            additionalProperties: false,
          },
        },
      },
      required: ['name', 'windows'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const t = await gc.post('/api/v2/outbound/callabletimesets', composeCallableTimeSet(a));
      return { created: true, id: t.id, name: t.name, callableTimes: t.callableTimes };
    },
  },
  {
    name: 'create_dnc_list',
    description: 'Create an internal Do-Not-Call list, optionally seeding it with phone numbers (max 100 here; add more later via another call). Attach to campaigns via create_campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        numbers: { type: 'array', items: { type: 'string' }, description: 'Initial DNC phone numbers' },
        division: { type: 'string', description: 'Division name or id' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const body = { name: a.name, dncSourceType: 'rds', contactMethod: 'Phone' };
      if (a.division) body.division = { id: (await resolveOne(gc, 'division', '/api/v2/authorization/divisions', a.division)).id };
      const d = await gc.post('/api/v2/outbound/dnclists', body);
      let numbersAdded = 0, numbersError;
      if (a.numbers?.length) {
        try {
          if (a.numbers.length > 100) throw new GenesysError('Max 100 numbers per call', 400);
          await gc.post(`/api/v2/outbound/dnclists/${d.id}/phonenumbers`, a.numbers.map(String));
          numbersAdded = a.numbers.length;
        } catch (e) { numbersError = e.message; }
      }
      return { created: true, id: d.id, name: d.name, numbersAdded, ...(numbersError ? { numbersError } : {}) };
    },
  },
  {
    name: 'list_campaigns',
    description: 'List outbound campaigns (name, dialing mode, status, contact list, queue).',
    inputSchema: {
      type: 'object',
      properties: { name_filter: { type: 'string', description: 'Campaign name filter, * wildcards allowed' } },
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const r = await gc.listAll('/api/v2/outbound/campaigns', a.name_filter ? { name: a.name_filter } : {});
      return {
        total: r.total, truncated: r.truncated,
        campaigns: r.entities.map((c) => ({
          id: c.id, name: c.name, dialingMode: c.dialingMode, campaignStatus: c.campaignStatus,
          contactList: c.contactList?.name, queue: c.queue?.name, division: c.division?.name,
        })),
      };
    },
  },
  {
    name: 'get_campaign',
    description: 'Get a campaign\'s full configuration (mode, list, queue, script, time set, DNC lists, caller id) by name or id.',
    inputSchema: {
      type: 'object',
      properties: { campaign: { type: 'string', description: 'Campaign name or id' } },
      required: ['campaign'],
      additionalProperties: false,
    },
    handler: async (gc, a) => gc.get(`/api/v2/outbound/campaigns/${(await resolveOne(gc, 'campaign', '/api/v2/outbound/campaigns', a.campaign)).id}`),
  },
  {
    name: 'create_campaign',
    description: 'Create an outbound campaign wired to a contact list and queue. ALWAYS created with status off - no tool here can start a campaign; a human turns it on in Genesys Admin. dialing_mode: preview (agent clicks to dial; default and safest), progressive, predictive, or agentless. Agent modes attach a script (defaults to the org\'s published outbound script); progressive/predictive/agentless need a call analysis response set (defaults to the org\'s default set). Phone columns are inherited from the contact list.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        contact_list: { type: 'string', description: 'Contact list name or id' },
        queue: { type: 'string', description: 'Queue name or id (required unless agentless)' },
        dialing_mode: { type: 'string', enum: ['preview', 'progressive', 'predictive', 'agentless'], description: 'Default preview' },
        caller_name: { type: 'string', description: 'Outbound caller id name' },
        caller_number: { type: 'string', description: 'Outbound caller id number (ANI)' },
        script: { type: 'string', description: 'Published script name or id (defaults to the org\'s outbound script)' },
        call_analysis_response_set: { type: 'string', description: 'Response set name or id (non-preview modes; defaults to the org default)' },
        callable_time_set: { type: 'string', description: 'Callable time set name or id (calling windows)' },
        dnc_lists: { type: 'array', items: { type: 'string' }, description: 'DNC list names or ids' },
        site: { type: 'string', description: 'Telephony site name or id (only if your org needs it)' },
        division: { type: 'string', description: 'Division name or id' },
        abandon_rate: { type: 'number', description: 'Target abandon rate % (progressive/predictive; default 3)' },
        outbound_line_count: { type: 'number', description: 'Lines for agentless campaigns (default 1)' },
        no_answer_timeout: { type: 'number', description: 'Seconds before a ring counts as no-answer' },
        priority: { type: 'number', description: '1-5' },
      },
      required: ['name', 'contact_list', 'caller_name', 'caller_number'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const mode = (a.dialing_mode || 'preview').toLowerCase();
      if (!DIALING_MODES.includes(mode)) throw new GenesysError(`dialing_mode must be one of: ${DIALING_MODES.join(', ')}`, 400);
      const list = await resolveOne(gc, 'contact list', '/api/v2/outbound/contactlists', a.contact_list);
      const listFull = await gc.get(`/api/v2/outbound/contactlists/${list.id}`);
      if (a.callable_time_set && listFull.automaticTimeZoneMapping) {
        throw new GenesysError(
          `Contact list "${listFull.name}" uses automatic time zone mapping, which conflicts with a campaign callable time set. ` +
          'Pick one: drop callable_time_set (Genesys dials each contact inside their local legal window), or use a contact list without zip-based mapping.', 400);
      }
      if (a.callable_time_set && !(listFull.phoneColumns || []).every((p) => p.callableTimeColumn)) {
        throw new GenesysError(
          `Contact list "${listFull.name}" has no time zone column on its phone columns, so Genesys will reject a callable time set. ` +
          'Create the list with time_zone_column (zone columns cannot be added later), or drop callable_time_set and use a zip_column list with automatic time zone mapping.', 400);
      }
      const body = {
        name: a.name, dialingMode: mode, campaignStatus: 'off',
        contactList: { id: list.id },
        phoneColumns: listFull.phoneColumns,
        callerName: a.caller_name, callerAddress: a.caller_number,
      };
      if (mode !== 'agentless') {
        if (!a.queue) throw new GenesysError(`dialing_mode ${mode} needs a queue`, 400);
        body.queue = { id: (await resolveOne(gc, 'queue', '/api/v2/routing/queues', a.queue)).id };
        const script = a.script
          ? await resolveOne(gc, 'script', '/api/v2/scripts/published', a.script)
          : ((await gc.get('/api/v2/scripts/published', { pageSize: 50 })).entities || []).find((s) => /outbound/i.test(s.name || ''));
        if (!script) throw new GenesysError('No published outbound script found - pass script explicitly', 400);
        body.script = { id: script.id };
      }
      if (mode !== 'preview') {
        const cars = a.call_analysis_response_set
          ? await resolveOne(gc, 'call analysis response set', '/api/v2/outbound/callanalysisresponsesets', a.call_analysis_response_set)
          : (await gc.listAll('/api/v2/outbound/callanalysisresponsesets')).entities.find((x) => /default/i.test(x.name || ''));
        if (!cars) throw new GenesysError('No call analysis response set found - create one in Admin or pass it explicitly', 400);
        body.callAnalysisResponseSet = { id: cars.id };
        if (mode !== 'agentless') body.abandonRate = a.abandon_rate ?? 3;
      }
      if (mode === 'agentless') body.outboundLineCount = a.outbound_line_count ?? 1;
      if (a.callable_time_set) body.callableTimeSet = { id: (await resolveOne(gc, 'callable time set', '/api/v2/outbound/callabletimesets', a.callable_time_set)).id };
      if (a.dnc_lists?.length) {
        body.dncLists = [];
        for (const d of a.dnc_lists) body.dncLists.push({ id: (await resolveOne(gc, 'DNC list', '/api/v2/outbound/dnclists', d)).id });
      }
      if (a.site) body.site = { id: (await resolveOne(gc, 'site', '/api/v2/telephony/providers/edges/sites', a.site)).id };
      if (a.division) body.division = { id: (await resolveOne(gc, 'division', '/api/v2/authorization/divisions', a.division)).id };
      if (a.no_answer_timeout) body.noAnswerTimeout = a.no_answer_timeout;
      if (a.priority) body.priority = a.priority;
      const c = await gc.post('/api/v2/outbound/campaigns', body);
      return {
        created: true, id: c.id, name: c.name, dialingMode: c.dialingMode, campaignStatus: c.campaignStatus,
        contactList: c.contactList?.name || listFull.name, queue: c.queue?.name,
        script: c.script?.name, callableTimeSet: c.callableTimeSet?.name, dncLists: c.dncLists?.map((d) => d.name),
        note: 'Created OFF by design. No tool here starts a campaign - a human turns it on in Admin > Outbound > Campaign Management.',
      };
    },
  },
  {
    name: 'create_campaign_sequence',
    description: 'Chain campaigns into an ordered cadence (a campaign sequence): campaign 1 runs to completion, then campaign 2, and so on. Pass campaigns in dialing order (names or ids). Created with status off; a human starts it. Render the result with render_cadence.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        campaigns: { type: 'array', items: { type: 'string' }, description: 'Campaign names or ids, in dialing order' },
      },
      required: ['name', 'campaigns'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      if (!Array.isArray(a.campaigns) || !a.campaigns.length) throw new GenesysError('campaigns must be a non-empty array', 400);
      const refs = [];
      for (const c of a.campaigns) refs.push({ id: (await resolveOne(gc, 'campaign', '/api/v2/outbound/campaigns', c)).id });
      const s = await gc.post('/api/v2/outbound/sequences', { name: a.name, campaigns: refs, status: 'off' });
      return {
        created: true, id: s.id, name: s.name, status: s.status,
        order: (s.campaigns || refs).map((c, i) => `${i + 1}. ${c.name || c.id}`),
        note: 'Sequence created OFF by design; a human starts it in Admin > Outbound > Campaign Management.',
      };
    },
  },
  {
    name: 'list_outbound_assets',
    description: 'One-call inventory of the org\'s outbound building blocks: sequences, attempt limits, callable time sets, DNC lists, call analysis response sets, telephony sites, and published scripts. Run this before building a cadence.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (gc) => {
      const [seq, al, cts, dnc, cars, sites, scripts] = await Promise.all([
        gc.listAll('/api/v2/outbound/sequences'),
        gc.listAll('/api/v2/outbound/attemptlimits'),
        gc.listAll('/api/v2/outbound/callabletimesets'),
        gc.listAll('/api/v2/outbound/dnclists'),
        gc.listAll('/api/v2/outbound/callanalysisresponsesets'),
        gc.listAll('/api/v2/telephony/providers/edges/sites'),
        gc.get('/api/v2/scripts/published', { pageSize: 50 }),
      ]);
      return {
        sequences: seq.entities.map((s) => ({ id: s.id, name: s.name, status: s.status, campaigns: s.campaigns?.map((c) => c.name ?? c.id) })),
        attemptLimits: al.entities.map((x) => ({ id: x.id, name: x.name, maxAttemptsPerContact: x.maxAttemptsPerContact })),
        callableTimeSets: cts.entities.map(slim),
        dncLists: dnc.entities.map(slim),
        callAnalysisResponseSets: cars.entities.map(slim),
        sites: sites.entities.map(slim),
        publishedScripts: (scripts.entities || []).map(slim),
      };
    },
  },
  {
    name: 'render_cadence',
    description: 'Render a campaign sequence (or a single campaign) as a Mermaid diagram showing each wave: dialing mode, queue, contact list size, attempt limits, calling windows, DNC. Show the user this after building a cadence.',
    inputSchema: {
      type: 'object',
      properties: {
        sequence: { type: 'string', description: 'Sequence name or id' },
        campaign: { type: 'string', description: 'Single campaign name or id (alternative to sequence)' },
      },
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      if (!a.sequence && !a.campaign) throw new GenesysError('Provide sequence or campaign', 400);
      let name = null, status = null, campRefs;
      if (a.sequence) {
        const ref = await resolveOne(gc, 'sequence', '/api/v2/outbound/sequences', a.sequence);
        const s = await gc.get(`/api/v2/outbound/sequences/${ref.id}`);
        name = s.name; status = s.status; campRefs = s.campaigns || [];
      } else {
        campRefs = [await resolveOne(gc, 'campaign', '/api/v2/outbound/campaigns', a.campaign)];
      }
      const campaigns = await Promise.all(campRefs.map((c) => gc.get(`/api/v2/outbound/campaigns/${c.id}`)));
      const listIds = [...new Set(campaigns.map((c) => c.contactList?.id).filter(Boolean))];
      const lists = Object.fromEntries(await Promise.all(listIds.map(async (id) => [id, await gc.get(`/api/v2/outbound/contactlists/${id}`, { includeSize: true })])));
      const steps = campaigns.map((c) => {
        const l = lists[c.contactList?.id];
        return {
          name: c.name, dialingMode: c.dialingMode, queue: c.queue?.name,
          contactList: l?.name, listSize: l?.size, attemptLimits: l?.attemptLimits?.name,
          timeSet: c.callableTimeSet?.name, dncLists: (c.dncLists || []).map((d) => d.name).filter(Boolean),
        };
      });
      return { mermaid: cadenceToMermaid(name, status, steps), note: 'Render the mermaid diagram for the user.' };
    },
  },

  // ----- flow building (Architect) -----
  {
    name: 'build_flow',
    description: 'Compose an inbound call flow from a spec WITHOUT publishing: validates it, returns the Archy YAML and a Mermaid diagram to show the user. Spec: { name, greeting, hours?: { schedule_group (existing group name, see create_schedule_group), closed_message, holiday_message?, closed_action?: disconnect|voicemail, closed_voicemail_queue?, closed_voicemail_greeting? }, menu: { prompt, choices: [{ dtmf: 0-9|*|#, action: transfer_to_queue|disconnect|voicemail|transfer_to_number|play_message, queue? (also the voicemail target: queue voicemail), number? (E.164), message? (play_message TTS), then? (play_message: return_to_menu|disconnect), name?, pre_transfer_message?, failure_message?, voicemail_greeting? }] }, description?, division?, language? }. Referenced queues and schedule groups must exist before publish. Show the diagram, get ONE approval, then call publish_flow with the same spec.',
    inputSchema: {
      type: 'object',
      properties: { spec: { type: 'object', description: 'The flow spec (see tool description)', additionalProperties: true } },
      required: ['spec'],
      additionalProperties: false,
    },
    genesys: false,
    handler: (_gc, a) => {
      const v = validateFlowSpec(a.spec);
      if (!v.ok) return { valid: false, errors: v.errors };
      return { valid: true, yaml: specToArchyYaml(a.spec), mermaid: specToMermaid(a.spec), note: 'Render the mermaid for the user and confirm before publish_flow.' };
    },
  },
    {
    name: 'get_bot_flow_intents',
    description:
      'Get all intents and sample utterances from a Genesys Cloud Architect Bot Flow. The tool exports the Bot Flow as YAML, waits for the export job to finish, downloads the YAML, and extracts the Natural Language Understanding intents and utterances.',
    inputSchema: {
      type: 'object',
      properties: {
        flow: {
          type: 'string',
          description:
            'Genesys Cloud Architect Bot Flow name or id.',
        },
        language: {
          type: 'string',
          description:
            'Optional language such as en-us. If omitted, return all languages found in the Bot Flow.',
        },
        include_utterances: {
          type: 'boolean',
          description:
            'Include sample utterances with each intent. Defaults to true.',
        },
      },
      required: ['flow'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
  const flow = await resolveOne(
    gc,
    'Bot Flow',
    '/api/v2/flows',
    a.flow
  );

  const flowDetails = await gc.get(
    `/api/v2/flows/${flow.id}`
  );

  const flowType = String(
    flowDetails.type || ''
  ).toLowerCase();

  if (
    flowType !== 'bot' &&
    flowType !== 'digitalbot'
  ) {
    throw new GenesysError(
      `"${flowDetails.name || a.flow}" is a ${flowDetails.type || 'non-bot'} flow. This tool only supports Architect Bot Flows and Digital Bot Flows.`,
      400
    );
  }

  return {
    readyForExport: true,
    flow: {
      id: flowDetails.id,
      name: flowDetails.name,
      type: flowDetails.type,
      description: flowDetails.description || null,
      division: flowDetails.division
        ? {
            id: flowDetails.division.id,
            name: flowDetails.division.name,
          }
        : null,
      publishedVersion:
        flowDetails.publishedVersion?.id || null,
      checkedInVersion:
        flowDetails.checkedInVersion?.id || null,
    },
    requestedLanguage: a.language || null,
    includeUtterances:
      a.include_utterances !== false,
    note:
      'The Bot Flow was resolved and validated. The export job has not been started yet.',
  };
},
  },
  
  {
    name: 'publish_flow',
    description: 'Create AND publish an Architect inbound call flow via the flow-jobs pipeline (validates server-side). Pass the spec from build_flow, or raw Archy YAML (spec OR yaml, not both). CAUTION: if the flow name matches an existing flow of the same type, Genesys UPDATES that flow, so use a fresh name unless an update is explicitly intended. Waits up to ~20s; if the job is still running, poll with get_flow_job.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: 'Flow spec (as for build_flow)', additionalProperties: true },
        yaml: { type: 'string', description: 'Raw Archy YAML (alternative to spec)' },
      },
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      // Both at once is ambiguous (which one would be published?), so refuse it.
      if (a.spec !== undefined && a.yaml !== undefined) throw new GenesysError('Pass spec or yaml, not both.', 400);
      if (a.yaml !== undefined && (typeof a.yaml !== 'string' || !a.yaml.trim())) throw new GenesysError('yaml must be a non-empty string.', 400);
      let yaml = a.yaml;
      if (!yaml) {
        if (!a.spec) throw new GenesysError('Provide spec or yaml', 400);
        const v = validateFlowSpec(a.spec);
        if (!v.ok) throw new GenesysError(`Invalid spec: ${v.errors.join('; ')}`, 400);
        yaml = specToArchyYaml(a.spec);
      }
      let job;
      try { job = await gc.post('/api/v2/flows/jobs', {}); }
      catch (e) { if (e.status === 400) job = await gc.api('POST', '/api/v2/flows/jobs', {}); else throw e; }
      const put = await gc.external(job.presignedUrl, { method: 'PUT', headers: job.headers || {}, body: yaml });
      if (!put.ok) throw new GenesysError(`YAML upload to the job URL failed: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`, put.status);
      const jobId = pathId('flow job id', job.id);
      let state = { status: 'Started' };
      for (let i = 0; i < 6 && !['Success', 'Failure'].includes(state.status); i++) {
        await new Promise((r) => setTimeout(r, 3500));
        state = await gc.get(`/api/v2/flows/jobs/${jobId}`, { expand: 'messages' });
      }
      return {
        jobId,
        status: state.status,
        flow: state.flow ? { id: state.flow.id, name: state.flow.name } : undefined,
        messages: state.messages?.length ? state.messages : undefined,
        note: ['Success', 'Failure'].includes(state.status)
          ? (state.status === 'Success' ? 'Flow created and published.' : 'Job failed; the messages above are the server-side validation report.')
          : 'Job still running; call get_flow_job with this jobId.',
      };
    },
  },
  {
    name: 'get_flow_job',
    description: 'Check a flow publish job\'s status (from publish_flow). Terminal statuses are Success and Failure; Failure messages are the server-side validation report.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const s = await gc.get(`/api/v2/flows/jobs/${pathId('job_id', a.job_id)}`, { expand: 'messages' });
      return { jobId: a.job_id, status: s.status, flow: s.flow ? { id: s.flow.id, name: s.flow.name } : undefined, messages: s.messages?.length ? s.messages : undefined };
    },
  },
  {
    name: 'export_flow',
    description: 'Export an existing flow as Archy YAML (name or id). Runs an export job and returns the YAML text; useful for inspecting or using a flow as a template. Secret-looking values (passwords, tokens, keys, credentials, Authorization headers, and the values of variables named like them) are replaced with [redacted], so the export is NOT a faithful backup: never publish it back as is without restoring those values in Architect. If the export is still running, call export_flow again with the returned job_id to check it instead of starting a new export.',
    inputSchema: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'Flow name or id' },
        job_id: { type: 'string', description: 'Export job id returned by an earlier export_flow call that was still running' },
      },
      required: ['flow'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      if (a.job_id !== undefined) pathId('job_id', a.job_id);
      const { id } = await resolveOne(gc, 'flow', '/api/v2/flows', a.flow);
      // A still-running export is checked by its job id instead of starting another job.
      const job = a.job_id ? await gc.get(`/api/v2/flows/export/jobs/${a.job_id}`) : await gc.post('/api/v2/flows/export/jobs', { flows: [{ flow: { id }, exportType: 'Yaml' }] });
      const jobId = pathId('export job id', a.job_id || job.id);
      let state = job;
      for (let i = 0; i < 6 && !['Success', 'Failure'].includes(state.status); i++) {
        await new Promise((r) => setTimeout(r, 3000));
        state = await gc.get(`/api/v2/flows/export/jobs/${jobId}`);
      }
      if (state.status !== 'Success') {
        return { jobId, status: state.status, messages: state.messages, note: state.status === 'Failure' ? 'Export failed.' : `Export still running: call export_flow again with the same flow and job_id "${jobId}" to check it (that does not start a new export).` };
      }
      const dl = await gc.external(state.downloadUrl);
      if (!dl.ok) throw new GenesysError(`Export download failed: HTTP ${dl.status}`, dl.status);
      // Secret-looking values in the export are redacted before truncation.
      const yaml = redactArchyYaml(await dl.text());
      return { flowId: id, yaml: yaml.length > 40000 ? yaml.slice(0, 40000) + '\n# …truncated' : yaml };
    },
  },
  {
    name: 'render_flow',
    description: 'Render a flow as a Mermaid diagram to show the user: pass spec (pre-publish preview, exact) OR flow (an existing flow by name/id; best-effort from its configuration, menus render faithfully).',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: 'Flow spec (as for build_flow)', additionalProperties: true },
        flow: { type: 'string', description: 'Existing flow name or id' },
      },
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      if (a.spec) {
        const v = validateFlowSpec(a.spec);
        if (!v.ok) return { valid: false, errors: v.errors };
        return { mermaid: specToMermaid(a.spec) };
      }
      if (!a.flow) throw new GenesysError('Provide spec or flow', 400);
      const { id } = await resolveOne(gc, 'flow', '/api/v2/flows', a.flow);
      const cfg = await gc.get(`/api/v2/flows/${id}/latestconfiguration`);
      return { flowId: id, name: cfg.name, type: cfg.type, mermaid: configToMermaid(cfg), note: 'Best-effort render of an existing flow; menus are faithful, complex logic is summarized.' };
    },
  },
  {
    name: 'unlock_flow',
    description: 'Unlock a flow that a failed job or an editor left checked out/locked (name or id). Only unlock flows this server created or is publishing to; a lock can mean a human is editing it.',
    inputSchema: {
      type: 'object',
      properties: { flow: { type: 'string', description: 'Flow name or id' } },
      required: ['flow'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const { id } = await resolveOne(gc, 'flow', '/api/v2/flows', a.flow);
      try {
        return await gc.api('POST', '/api/v2/flows/actions/unlock', { query: { flow: id } });
      } catch (e) {
        if (e.status === 400) return await gc.api('POST', '/api/v2/flows/actions/unlock', { query: { flowId: id } });
        throw e;
      }
    },
  },

  // ----- power tool -----
  {
    name: 'genesys_api_call',
    description: 'Call a Genesys Cloud Platform API endpoint directly (for endpoints without a typed tool). GETs work anywhere under /api/v2/. Writes (POST/PUT/PATCH) are limited to an allowlist of the families the typed tools build: divisions, WebRTC phones, queues, skills, wrap-up codes, user routing skills, schedules, flows (not publish), outbound contact lists/attempt limits/callable time sets/DNC lists/campaigns/sequences, AVAs (not publish), knowledge, and data action drafts. WebRTC phone creation is specifically allowed through POST /api/v2/telephony/providers/edges/phones.  Paths must be plain (no %, ;, \\, #, ?, whitespace, or dot segments). Secret-looking fields are redacted from responses. Treat any non-GET call as a write: describe the method, path, and body and confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH'] },
        path: { type: 'string', description: 'API path starting with /api/v2/, e.g. /api/v2/routing/queues' },
        query: { type: 'object', description: 'Query string parameters', additionalProperties: true },
        body: { type: 'object', description: 'JSON body for POST/PUT/PATCH', additionalProperties: true},
        },
      required: ['method', 'path'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      // Enforced in code, not just by policy: normalize, then allowlist
      // (see rules.js). Runs before any URL is built.
      const refusal = refusalFor(a.method, a.path, a.body, a.query);
      if (refusal) throw new GenesysError(refusal, 403);
      return redactSecrets(await gc.api(a.method, a.path, { body: a.body, query: a.query }));
    },
  },

  // ----- agentic virtual agents (see ava-tools.js) -----
  ...AVA_TOOLS,
];

// ---------- registry plumbing ----------

export function toolDefs() {
  return TOOLS.map(({ name, description, inputSchema, genesys }) => {
    // Tools that do not connect to Genesys Cloud do not need an org selector.
    if (genesys === false) {
      return {
        name,
        description,
        inputSchema
      };
    }

    // Add the Genesys Cloud organization selector to every Genesys tool.
    return {
      name,
      description,
      inputSchema: {
        ...inputSchema,
        properties: {
          org: {
            type: 'string',
            enum: ['dev', 'edcisbu'],
            description:
              'Genesys Cloud organization to use. Use "dev" for GC Orgs - East Region or "edcisbu" for GC Orgs - West Region.'
          },
          ...(inputSchema?.properties || {})
        }
      }
    };
  });
}
export async function callTool(cfg, name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);

  if (!tool) {
    throw new GenesysError(`Unknown tool: ${name}`, 404);
  }

  // Arguments must be an object.
  if (args === undefined || args === null) {
    args = {};
  }

  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new GenesysError(
      'Tool arguments must be a JSON object.',
      400
    );
  }

  /*
   * index.js already used args.org to select the correct
   * configuration. Remove org before passing the remaining
   * arguments to the individual tool handler.
   */
  const { org: _selectedOrg, ...toolArgs } = args;

  if (tool.genesys === false) {
    return tool.handler(null, toolArgs, cfg);
  }

  if (!cfg.configured) {
    throw new GenesysError(
      'This server is not connected to Genesys Cloud yet - open /setup, or set the GENESYS_CLIENT_ID / GENESYS_CLIENT_SECRET / GENESYS_REGION secrets.',
      503
    );
  }

  const gc = new GenesysClient(cfg);

  return tool.handler(gc, toolArgs, cfg);
}

// UI metadata - which tools are writes, and how they group on the landing page.
export const WRITE_TOOLS = new Set([
  'create_queue', 'create_user', 'update_queue_members', 'create_wrapup_code', 'create_skill', 'assign_user_skill', 'remove_user_skill', 'set_user_direct_routing_tag', 'update_user_contact_options',
  'create_schedule', 'create_schedule_group', 'create_customer_survey_form', 'update_group_users', 'create_quality_evaluation_form', 'create_mock_data_action', 'replace_mock_responses',
  'create_contact_list', 'add_contacts', 'create_attempt_limits', 'create_flow_outcome', 'list_flow_outcomes'
  'create_callable_time_set', 'create_dnc_list', 'create_campaign',
  'create_campaign_sequence',
  'publish_flow', 'unlock_flow', 'genesys_api_call',
  ...AVA_WRITE_TOOLS,
]);

export const TOOL_GROUPS = [
  { name: 'Org & Connection', icon: '🔌', tools: ['about', 'check_connection', 'list_divisions', 'list_did_pools'] },
  { name: 'Mock Data Actions', icon: '🧪', tools: ['create_mock_data_action', 'replace_mock_responses' ] },
  { name: 'Quality Management', icon: '📊', tools: ['list_quality_evaluations', 'get_quality_evaluation', 'get_quality_evaluation_form', 'get_quality_question_scores', 'get_quality_conversation', 'create_quality_evaluation_form',] },
  { name: 'Customer Surveys', icon: '📝', tools: ['list_quality_surveys', 'find_quality_survey_responses', 'get_quality_survey', 'get_quality_survey_form', 'get_quality_survey_question_scores', 'create_customer_survey_form',] },
  { name: 'Conversations & Interaction Details', icon: '🔎', tools: ['search_conversations_by_attribute', 'get_conversation_details', 'trace_interaction', 'find_repeat_contacts' ] },
  { name: 'Queues & Routing', icon: '📞', tools: ['list_queues', 'get_queue', 'create_queue', 'list_queue_members', 'update_queue_members', 'list_wrapup_codes', 'create_wrapup_code'] },
  { name: 'Users & Skills', icon: '👥', tools: ['list_users', 'get_user', 'create_user', 'list_skills', 'create_skill', 'assign_user_skill', 'remove_user_skill', 'update_user_contact_options', 'set_user_direct_routing_tag'] },
  { name: 'Groups', icon: '👨‍👩‍👧‍👦', tools: ['update_group_users'] },
  { name: 'Schedules & Hours', icon: '🕐', tools: ['list_schedules', 'create_schedule', 'create_schedule_group'] },
  { name: 'Outbound (Campaigns & Cadences)', icon: '📤', tools: ['list_contact_lists', 'get_contact_list', 'create_contact_list', 'add_contacts', 'create_attempt_limits', 'create_callable_time_set', 'create_dnc_list', 'list_campaigns', 'get_campaign', 'create_campaign', 'create_campaign_sequence', 'list_outbound_assets', 'render_cadence'] },
  { name: 'Flow Analytics & Instrumentation', icon: '📈', tools: ['list_flow_outcomes', 'create_flow_outcome']},
  { name: 'Flows (Architect)', icon: '🌳', tools: ['list_flows', 'get_flow', 'get_flow_configuration', 'list_prompts', 'render_flow', 'export_flow', 'get_bot_flow_intents'] },
  { name: 'Flow Builder', icon: '🏗️', tools: ['build_flow', 'publish_flow', 'get_flow_job', 'unlock_flow'] },
  AVA_TOOL_GROUP,
  { name: 'Power', icon: '⚡', tools: ['genesys_api_call'] },
];

export { REGIONS };
