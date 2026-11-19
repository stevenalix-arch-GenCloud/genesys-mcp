---
name: ava-dispatch
description: >
  Coordinate the Genesys Cloud Agentic Virtual Agent lifecycle.
  Use when a user wants to create a new AVA, update an existing AVA,
  review an AVA, or continue through design, knowledge, build, test,
  evaluation, and critique. Establish the Genesys Cloud organization
  and the user's intent before selecting the appropriate AVA workflow.
metadata:
  version: 0.1.0
  source-version: 1.5.6
  source: Genesys Cloud Services, Inc.
license: MIT. Adapted from the Genesys AVA Skills project.
---

# Genesys Cloud AVA Dispatcher

This skill is the entry point for Genesys Cloud Agentic Virtual Agent
work. Determine what the user wants to accomplish and route the request
to the correct AVA skill.

Lifecycle:

dispatch → design → knowledge when needed → build → test → evaluate → critique

## Safety rules

- Do not create, update, publish, or delete anything unless the user
  explicitly requested that operation.
- Present a concise preview before creating or updating an AVA.
- Require explicit user confirmation before publishing an AVA version.
- Do not expose OAuth credentials, client secrets, access tokens, or
  MCP authentication values.
- Use the Genesys organization selected by the user.
- If the organization is unclear and more than one organization is
  available, ask the user to select one.
- Prefer read-only discovery before making changes.
- Do not retrieve all AVAs unless the user explicitly asks to browse
  all AVAs.

## Step 1: Determine the user's intent

Use the user's message to determine the intended operation.

Supported intents:

1. Create a new AVA.
2. Update an existing AVA.
3. Review or critique an existing AVA.
4. Test an existing AVA.
5. Evaluate test results.
6. Continue a previously started AVA project.
7. Browse existing AVAs.

If the user's intent is already clear, continue without presenting a
menu.

If the intent is unclear, ask:

"What would you like to do?

1. Create a new AVA
2. Update an existing AVA
3. Review an existing AVA
4. Test or evaluate an existing AVA
5. Continue a previous AVA project
6. Browse existing AVAs"

## Step 2: Establish the Genesys Cloud organization

If the user supplied an organization name, use it.

If no organization was supplied:

- Use the current organization when the MCP connection has one
  unambiguous default organization.
- If several organizations are configured, list the available
  organizations and ask the user to select one.
- Do not guess which organization the user intends to change.

Carry the selected organization through every subsequent MCP operation.

## Step 3: Locate an existing AVA only when necessary

For a new AVA:

- Do not list every existing AVA.
- Ask for the AVA name if the user did not provide one.
- The build process must check for a name collision before creating it.

For an existing AVA:

- Ask for its name or a distinctive part of its name if not provided.
- Call the Genesys MCP resource-discovery tool using the name as a filter.
- If exactly one clear match is returned, use it.
- If multiple matches are returned, present the matches and ask the user
  to select one.
- If no match is found, tell the user and offer to search again or start
  a new AVA.

Only retrieve every AVA when the user explicitly asks to browse all AVAs.

## Step 4: Load the current AVA configuration

For an update, review, test, evaluation, or critique request:

- Retrieve the AVA's identity and current status.
- Retrieve its latest saved version when available.
- Retrieve its latest published version when available.
- Clearly identify whether the reviewed configuration is saved,
  published, or both.
- Do not assume the saved and published versions are identical.

If the saved version is newer than the published version, explain that
unpublished changes exist before continuing.

## Step 5: Select the correct skill

Route the work according to the user's intent:

| User intent | Skill |
| --- | --- |
| Create a new AVA | ava-design |
| Change an existing AVA | ava-design |
| Create or prepare Knowledge Fabric content | ava-knowledge |
| Create the AVA or save a new version | ava-build |
| Test an AVA conversation | ava-test |
| Score test results | ava-evaluate |
| Review quality and recommend improvements | ava-critique |
| Analyze existing AVA information or results | ava-analysis |

When the workflow requires several skills, use this order:

1. ava-design
2. ava-knowledge, if required
3. ava-build
4. ava-test
5. ava-evaluate
6. ava-critique

Do not skip directly to build if the AVA design has not been reviewed
with the user.

## Step 6: Carry forward the working context

Carry this information into the next skill when available:

- Genesys organization name or identifier
- Operation mode: new, update, review, test, or evaluate
- AVA name
- AVA identifier
- Latest saved version
- Latest published version
- Current AVA definition
- User's requested change or intended use case
- Required Genesys tools or Data Actions
- Required Knowledge Fabric sources or settings
- User-approved design decisions
- Outstanding questions
- Whether the user approved creation or update
- Whether the user approved publication

Do not ask the user for information that has already been established.

## Step 7: Handle continuation safely

When the user wants to continue previous work:

- Use available project-state tools to locate the saved AVA project.
- If no project-state tool is available, retrieve the current AVA
  configuration from Genesys Cloud and ask which lifecycle step the
  user wants to continue.
- Do not claim that local design artifacts or test results exist unless
  they were actually retrieved.
- If the live AVA changed since the stored project state was created,
  present the difference and ask whether to use the live version or
  continue from the stored design.

## Step 8: Confirm consequential actions

The skills may design, review, and test without a publishing confirmation.

Before creating an AVA or saving a changed version:

1. Summarize the intended configuration.
2. Identify the target Genesys organization.
3. Identify the AVA being created or changed.
4. Ask for confirmation if the user has not already clearly approved
   the operation.

Before publishing:

1. Identify the version to be published.
2. Summarize the changes.
3. Explain that publishing makes the version active.
4. Obtain explicit confirmation.
5. Call the publishing tool only after confirmation.

## Missing tools

If a required Genesys MCP tool is unavailable:

- State which operation cannot be completed.
- Do not pretend the operation succeeded.
- Continue with any design or analysis that can be completed safely.
- Identify the MCP capability that must be added.
