---
name: ava-design
description: >
  Design or update a Genesys Cloud Agentic Virtual Agent configuration.
  Use when collecting or editing the AVA name, role, instructions,
  guardrails, tools, events, context variables, output data, and test
  cases. Work one field at a time and obtain the user's approval before
  treating a proposed value as final.
metadata:
  version: 0.1.0
  source-version: 1.5.6
  source: Genesys Cloud Services, Inc.
license: MIT. Adapted from the Genesys AVA Skills project.
---

# Genesys Cloud AVA Designer

Design a complete Genesys Cloud AVA configuration that can be passed to
the AVA build process.

This skill supports:

- Creating a new AVA design
- Updating an existing AVA design
- Extracting requirements from user-provided documents
- Selecting Genesys Data Actions and knowledge resources
- Creating test cases
- Validating the design before creation or update

## Interaction rules

Follow these rules throughout the design process:

1. Work on one design field at a time.
2. Do not invent values that the user has not provided or approved.
3. Suggestions must be clearly labeled as suggestions.
4. A suggested value becomes final only after the user approves it.
5. Reuse information the user has already supplied.
6. Do not ask again for information already established.
7. The steps are a checklist, not a mandatory question order.
8. If the user starts with tools, knowledge, or another field, handle
   that field first.
9. Before creating or updating anything in Genesys Cloud, present the
   complete design and obtain confirmation.
10. Publishing requires a separate explicit confirmation.

## Design checklist

Track these fields during the conversation:

1. Name
2. Role
3. Instructions
4. Guardrails
5. Tools
6. Events
7. Start Context
8. End Context
9. Test cases

For an existing AVA, preserve fields the user did not ask to change.

## Starting mode

### New AVA

For a new AVA:

- Collect only missing information.
- Use details already provided in the conversation or documents.
- Confirm each field with the user.
- Do not create the AVA until the complete design is approved.

### Existing AVA

For an update:

1. Retrieve the latest saved and published configurations through the
   Genesys MCP.
2. Identify whether unpublished changes exist.
3. Present a short summary containing:
   - AVA name
   - Role summary
   - Number of instructions
   - Number of guardrails
   - Number of tools
   - Current event configuration
4. Ask what the user wants to change.
5. Modify only the requested fields.
6. Show each requested field as before and after.
7. Surface ripple effects instead of silently changing related fields.
8. Present a final difference summary before saving a new version.

## Step 1: Name

Collect or confirm an AVA name between 3 and 100 characters.

The name should describe the AVA's business purpose.

Good examples:

- Acme Order Assistant
- Member Benefits Assistant
- Appointment Scheduling Assistant
- Travel Concierge

Avoid generic names such as:

- Test
- Bot
- Agent
- AVA
- Assistant
- My Bot
- Support Bot

If a proposed name is too generic, explain the issue and suggest two or
three business-specific alternatives based only on the user's stated
use case.

Before continuing, ask:

"Your AVA will be named '{name}'. Would you like to change it, or move
to the role?"

## Step 2: Role

Collect or confirm the AVA's role. The role may be up to 5,000
characters.

The role should define:

- Identity and business domain
- Tone
- Supported tasks
- Out-of-scope topics
- Customer term, such as customer, member, patient, or caller
- Channel: voice, chat, or both
- Grounding requirements

When the AVA uses tools or serves a regulated domain, include a grounding
rule such as:

"Answer account-specific questions only from connected tool results. If
the answer is unavailable from those sources, explain that the
information is unavailable."

Use the user's words as the basis for the role. If the user is unsure,
provide a suggested role and ask the user to approve or edit it.

If the role is vague, such as "You are a helpful assistant," explain
that the role needs a business purpose, supported tasks, and scope.

For a voice or voice-and-chat AVA, ask whether the user wants
voice-specific guidance covering:

- Short conversational responses
- Confirmation of important values
- No more than three points per response
- Recovery from speech-recognition errors

Before continuing, show the complete role and ask for approval.

## Step 3: Instructions

Collect behavioral instructions. Each instruction should describe one
clear conversation-wide behavior.

Good global instructions cover:

- Tone and brevity
- Clarification behavior
- Confirmation behavior
- Grounding
- Handling ambiguous requests
- Voice or digital response style

Instructions should:

- Be specific and actionable
- Prefer positive phrasing
- Define one behavior each
- Use examples when helpful
- Avoid calculations that should be performed by a backend tool
- Avoid repeating capabilities already defined by tools

Tool-specific behavior belongs with the tool:

- When to call a tool belongs in its input instructions.
- What to do with a tool result belongs in its output instructions.
- Multi-tool data flow belongs in tool mappings, not prose.
- Backend capabilities should be configured as tools, not global
  instructions.

After any instruction edit, show the complete numbered instruction list
and ask the user to approve it.

---
name: ava-design
description: >
  Design or update a Genesys Cloud Agentic Virtual Agent configuration.
  Use when collecting or editing the AVA name, role, instructions,
  guardrails, tools, events, context variables, output data, and test
  cases. Work one field at a time and obtain the user's approval before
  treating a proposed value as final.
metadata:
  version: 0.1.0
  source-version: 1.5.6
  source: Genesys Cloud Services, Inc.
license: MIT. Adapted from the Genesys AVA Skills project.
---

# Genesys Cloud AVA Designer

Design a complete Genesys Cloud AVA configuration that can be passed to
the AVA build process.

This skill supports:

- Creating a new AVA design
- Updating an existing AVA design
- Extracting requirements from user-provided documents
- Selecting Genesys Data Actions and knowledge resources
- Creating test cases
- Validating the design before creation or update

## Interaction rules

Follow these rules throughout the design process:

1. Work on one design field at a time.
2. Do not invent values that the user has not provided or approved.
3. Suggestions must be clearly labeled as suggestions.
4. A suggested value becomes final only after the user approves it.
5. Reuse information the user has already supplied.
6. Do not ask again for information already established.
7. The steps are a checklist, not a mandatory question order.
8. If the user starts with tools, knowledge, or another field, handle
   that field first.
9. Before creating or updating anything in Genesys Cloud, present the
   complete design and obtain confirmation.
10. Publishing requires a separate explicit confirmation.

## Design checklist

Track these fields during the conversation:

1. Name
2. Role
3. Instructions
4. Guardrails
5. Tools
6. Events
7. Start Context
8. End Context
9. Test cases

For an existing AVA, preserve fields the user did not ask to change.

## Starting mode

### New AVA

For a new AVA:

- Collect only missing information.
- Use details already provided in the conversation or documents.
- Confirm each field with the user.
- Do not create the AVA until the complete design is approved.

### Existing AVA

For an update:

1. Retrieve the latest saved and published configurations through the
   Genesys MCP.
2. Identify whether unpublished changes exist.
3. Present a short summary containing:
   - AVA name
   - Role summary
   - Number of instructions
   - Number of guardrails
   - Number of tools
   - Current event configuration
4. Ask what the user wants to change.
5. Modify only the requested fields.
6. Show each requested field as before and after.
7. Surface ripple effects instead of silently changing related fields.
8. Present a final difference summary before saving a new version.

## Step 1: Name

Collect or confirm an AVA name between 3 and 100 characters.

The name should describe the AVA's business purpose.

Good examples:

- Acme Order Assistant
- Member Benefits Assistant
- Appointment Scheduling Assistant
- Travel Concierge

Avoid generic names such as:

- Test
- Bot
- Agent
- AVA
- Assistant
- My Bot
- Support Bot

If a proposed name is too generic, explain the issue and suggest two or
three business-specific alternatives based only on the user's stated
use case.

Before continuing, ask:

"Your AVA will be named '{name}'. Would you like to change it, or move
to the role?"

## Step 2: Role

Collect or confirm the AVA's role. The role may be up to 5,000
characters.

The role should define:

- Identity and business domain
- Tone
- Supported tasks
- Out-of-scope topics
- Customer term, such as customer, member, patient, or caller
- Channel: voice, chat, or both
- Grounding requirements

When the AVA uses tools or serves a regulated domain, include a grounding
rule such as:

"Answer account-specific questions only from connected tool results. If
the answer is unavailable from those sources, explain that the
information is unavailable."

Use the user's words as the basis for the role. If the user is unsure,
provide a suggested role and ask the user to approve or edit it.

If the role is vague, such as "You are a helpful assistant," explain
that the role needs a business purpose, supported tasks, and scope.

For a voice or voice-and-chat AVA, ask whether the user wants
voice-specific guidance covering:

- Short conversational responses
- Confirmation of important values
- No more than three points per response
- Recovery from speech-recognition errors

Before continuing, show the complete role and ask for approval.

## Step 3: Instructions

Collect behavioral instructions. Each instruction should describe one
clear conversation-wide behavior.

Good global instructions cover:

- Tone and brevity
- Clarification behavior
- Confirmation behavior
- Grounding
- Handling ambiguous requests
- Voice or digital response style

Instructions should:

- Be specific and actionable
- Prefer positive phrasing
- Define one behavior each
- Use examples when helpful
- Avoid calculations that should be performed by a backend tool
- Avoid repeating capabilities already defined by tools

Tool-specific behavior belongs with the tool:

- When to call a tool belongs in its input instructions.
- What to do with a tool result belongs in its output instructions.
- Multi-tool data flow belongs in tool mappings, not prose.
- Backend capabilities should be configured as tools, not global
  instructions.

After any instruction edit, show the complete numbered instruction list
and ask the user to approve it.

## Step 6: Events

Collect or confirm the AVA's event configuration.

Events may include:

- `UserExit.message`
- `Escalation.message`
- `Guardrails.violationThreshold`
- `Guardrails.warningMessage`
- `Guardrails.thresholdCrossedMessage`

Keep event messages short, clear, and conversational, especially for
voice interactions.

A typical guardrail violation threshold is 3, but the user must approve
the value. Valid values are 1 through 10.

Event messages guide the AVA and may be paraphrased. If exact legal or
compliance wording is required, use an approved backend tool rather than
relying on an event message.

Hidden tools such as `end_conversation` and
`escalate_to_human_agent` should be used only for specific outcomes.

Avoid broad instructions that could cause premature conversation exits.

Show the complete events setup and ask the user to approve it.

## Step 7: Start Context

Start Context contains optional values supplied when the conversation
begins.

Use Start Context for small, static values such as:

- Customer identifier
- Caller telephone number
- Language preference
- Business unit
- Account classification

Do not use Start Context for:

- Large lists
- Raw JSON
- Values that should be retrieved by a tool
- Sensitive information that the AVA does not need
- Dynamic data likely to change during the conversation

Each Start Context variable must have:

- A snake_case property name
- A clear usage description
- A named primitive alias type
- `required: false`

Create exactly one `InputData` type when Start Context is used.

The `InputData` type must:

- Use `direction: "agentInput"`
- Use `type: "object"`
- Contain the Start Context properties
- Not contain a `description` field
- Not mark any property as required

Each property must reference a separately declared named primitive type.

Example:

```json
{
  "types": [
    {
      "name": "CustomerId",
      "description": "The identifier supplied by the calling flow for the customer whose request is being handled.",
      "type": "string",
      "userUtteranceSubstring": false
    },
    {
      "name": "InputData",
      "direction": "agentInput",
      "type": "object",
      "properties": [
        {
          "name": "customer_id",
          "type": "CustomerId",
          "required": false
        }
      ]
    }
  ]
}
