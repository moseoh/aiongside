# Working with AIongside

AIongside helps you and AI keep work in a local workspace: what you are trying to achieve, what happened, which decisions were made, and what the result was. In a later conversation, ask AI to read those records and continue. Reusable knowledge can be kept separately for future work.

This guide assumes your workspace and agent integration are already set up. Speak to AI in your own language. You do not need to learn CLI commands or manually maintain the documents to follow these examples.

## Start work

Tell AI what you want to accomplish and ask it to register the work:

> We need to improve customer onboarding. Register this as work. First, help me identify the problems in our current process.

Give it the background, available materials, constraints, and the result you want. AI can clarify missing details and record the scope and completion conditions. You decide the intended outcome; AI maintains the work record as you collaborate.

You can also capture something for later:

> Record this as work for later: review our onboarding email templates.

Registering work does not mean it must be carried out immediately.

## Work together

Ask for concrete actions and supply information as it becomes available:

> Here is the current onboarding checklist. Find missing steps and draft an improved version.

> We decided to keep the existing welcome email. Record that decision and adjust the plan.

AI uses relevant workspace knowledge and reference materials, performs the requested work, and records progress, decisions, and observed results. Drafts and final outputs belong with the work so you can review them later. Review the output and give corrections or decisions where needed.

## Check progress and results

> Where are we on the onboarding work? What is left, and what do you need from me?

AI should explain the current state, remaining actions, and unresolved questions based on the records. You can also ask it to show a deliverable or open the workspace's read-only Work view. That view lets you browse Work documents; request changes through AI or edit the documents rather than expecting to edit in the view.

## Wait and resume

> We need the support team's response before continuing. Record what we are waiting for and when to resume.

When the response arrives:

> The support team approved the checklist. Continue the onboarding work using their feedback below.

AI records the reason for waiting and the condition for resuming, then updates the work when that condition is met. A recorded waiting condition is not an automatic notification or background monitor.

## Continue in another conversation

Open the same workspace with your configured AI agent and identify the work:

> Continue the customer onboarding work. Read the existing record and plan, then tell me the next step.

Use the work ID if several items have similar titles. AI can recover the recorded context; details left only in an earlier chat may be unavailable. Ask AI to record significant decisions and results before ending a conversation.

## Complete or revisit work

> Check the result against our completion conditions. If they are met, complete the work and explain the outcome.

AI reviews the scope, result, and verification evidence, records the outcome, and completes the work when appropriate. Mechanical checks help keep the workspace consistent; they do not establish that a result is correct. You and AI still need to review the substance.

> The requirements changed. Reopen the onboarding work and update the checklist for the new process.

Completed work preserves its result. AI reopens it with a reason before changing that result. If work is no longer needed, you can ask to cancel it with a reason while retaining its history.

## Keep knowledge for future work

> Keep the reusable onboarding rules from this completed work in our knowledge, and tell me what you updated.

AI compares the results with relevant existing knowledge and adds or corrects useful content. It should tell you what changed or why no update is needed. Not every draft, progress note, or consulted reference belongs in reusable knowledge.

You can also manage established knowledge independently:

> Record this approved company policy so we can refer to it in future work.

> What do we already know about customer onboarding? Use the relevant knowledge for this task.

## What to ask AI to handle

You provide goals, context, constraints, feedback, and decisions. Ask AI to handle creating and finding work, maintaining records and plans, updating status, checking document consistency, organizing outputs, and preserving reusable knowledge. AI follows the permissions and approval rules of your workspace for the requested actions.

Start with a simple request: "I want to work on this with you. Register it in AIongside and help me decide the next step."
