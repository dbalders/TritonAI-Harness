/**
 * Ideas for people who do not know yet what to use TritonAI for. They need no
 * project, file, or plugin: each prompt asks for what it needs in square
 * brackets. The first few fill a new user's page, so they cover different kinds
 * of work and end with one that learns about the user.
 */
export interface StarterIdea {
  readonly id: string;
  readonly icon: string;
  readonly title: string;
  readonly body: string;
  readonly prompt: string;
}

export const STARTER_IDEAS: ReadonlyArray<StarterIdea> = [
  {
    id: "meeting-follow-up",
    icon: "📝",
    title: "I can turn meeting notes into a follow-up email",
    body: "Paste your notes and I'll draft a short email with the decisions, who owns each next step, and the deadlines.",
    prompt:
      "Turn these meeting notes into a short follow-up email. List the decisions, who owns each next step, and any deadlines. Keep it friendly and under 200 words.\n\nMeeting notes:\n[paste your notes here]",
  },
  {
    id: "clean-spreadsheet",
    icon: "📊",
    title: "I can clean up a messy spreadsheet and explain it",
    body: "Put a CSV or Excel file in a project and I'll fix the formatting, flag problems, and tell you what the data shows.",
    prompt:
      "Look at the spreadsheet [file name] in this project. Clean it up: fix inconsistent dates and names, remove duplicate rows, and flag anything that looks wrong. Save the cleaned copy next to the original, then tell me in plain language what the data shows.",
  },
  {
    id: "document-questions",
    icon: "📄",
    title: "Ask me questions about a long document",
    body: "Give me a policy, contract, or report and I'll answer your questions, quoting the parts I relied on.",
    prompt:
      "Read [document name, or paste the text below] and answer my questions about it. Quote the exact passage you relied on for each answer, and tell me when the document doesn't say.\n\nMy first question: [your question]",
  },
  {
    id: "weekly-plan",
    icon: "🗓️",
    title: "Tell me what's on your plate and I'll make a plan",
    body: "List your tasks, meetings, and deadlines. I'll turn them into a realistic day-by-day plan and point out what won't fit.",
    prompt:
      "Here's everything on my plate this week: [list your tasks, meetings, and deadlines]. Turn it into a realistic day-by-day plan. Put the most important and time-sensitive work first, and point out anything that won't fit.",
  },
  {
    id: "automate-task",
    icon: "🛠️",
    title: "Describe a repetitive task and I'll help automate it",
    body: "Tell me the steps you repeat. I'll suggest ways to automate them, simplest first, and build one with you.",
    prompt:
      "I do this task regularly: [describe the steps, how often, and which files or websites are involved]. Suggest how it could be automated, from the simplest option to the most complete. Then build the simplest version with me step by step.",
  },
  {
    id: "about-my-work",
    icon: "💬",
    title: "Tell me about your work so I can suggest better ideas",
    body: "Answer a few quick questions about your role and tasks. Your next ideas will be based on what you tell me.",
    prompt:
      "Help me get more out of TritonAI. Ask me a few short questions, one at a time, about my role, my team, and the tasks I spend the most time on. Then suggest five specific ways you could help me, starting with the one that would save me the most time.",
  },
  {
    id: "rewrite-email",
    icon: "✉️",
    title: "I can make a tricky email clearer and kinder",
    body: "Paste a draft you're unsure about. I'll tighten it, keep your meaning, and point out anything that could be misread.",
    prompt:
      "Rewrite this email so it's clear, polite, and to the point. Keep my meaning, and point out anything that could be misread.\n\nEmail:\n[paste your draft]",
  },
  {
    id: "summarize-email-thread",
    icon: "📬",
    title: "I can summarize a long email chain",
    body: "Paste the thread and I'll tell you what was decided, what's still open, and what you need to do.",
    prompt:
      "Summarize this email thread. Tell me what was decided, what's still open, and what (if anything) I need to do.\n\nThread:\n[paste the email thread]",
  },
  {
    id: "meeting-agenda",
    icon: "📋",
    title: "I can draft an agenda for your next meeting",
    body: "Tell me the goal, who's coming, and how long you have. I'll time each item and end with the decision you need.",
    prompt:
      "Draft a meeting agenda for [meeting name] with [who's attending]. The goal is [goal]. We have [length] minutes. Include time for each item and the decision we need at the end.",
  },
  {
    id: "chart-data",
    icon: "📈",
    title: "I can turn a table of numbers into a chart",
    body: "Paste a table or name a file. I'll pick the right chart, save it as an image, and explain what it shows.",
    prompt:
      "Make a clear chart from this data and save it as an image in this project. Pick the chart type that fits best and explain why. Then write two or three sentences on what it shows.\n\nData:\n[paste a table or name a file]",
  },
  {
    id: "spreadsheet-formula",
    icon: "🧮",
    title: "I can write the spreadsheet formula you need",
    body: "Describe your columns and what you want to calculate. You'll get the formula for Excel and Google Sheets, explained.",
    prompt:
      "I need a spreadsheet formula. My data looks like this: [describe the columns]. I want to [what you want to calculate]. Give me the formula for Excel and Google Sheets, and explain how it works.",
  },
  {
    id: "compare-options",
    icon: "⚖️",
    title: "I can compare your options side by side",
    body: "List the choices and what matters to you. I'll build a comparison table and give you a recommendation.",
    prompt:
      "Help me decide between these options: [list them]. What matters most to me: [your priorities]. Make a side-by-side comparison table, then give me your recommendation and the main risk of each option.",
  },
  {
    id: "presentation-outline",
    icon: "🖼️",
    title: "I can outline a presentation for you",
    body: "Give me the topic and audience. Each slide gets a title, three bullets, and a speaker note.",
    prompt:
      "Outline a [number]-slide presentation on [topic] for [audience]. Give each slide a title, three short bullet points, and a speaker note. Keep the language plain.",
  },
  {
    id: "job-description",
    icon: "🧑‍💼",
    title: "I can draft or refresh a job description",
    body: "Tell me the role and main duties. I'll write an inclusive, readable description and flag what to check with HR.",
    prompt:
      "Draft a job description for a [job title] in [department]. Main duties: [list]. Required skills: [list]. Keep it inclusive and easy to read, and flag anything I should check with HR.",
  },
  {
    id: "survey-themes",
    icon: "🗳️",
    title: "I can find the themes in survey responses",
    body: "Paste open-ended responses or name a file. I'll group them into themes, count them, and suggest actions.",
    prompt:
      "Here are open-ended survey responses: [paste them or name a file]. Group them into themes, count how many responses fit each, quote one typical response per theme, and suggest three actions.",
  },
  {
    id: "process-instructions",
    icon: "🧭",
    title: "I can write step-by-step instructions for a process",
    body: "Describe how something gets done today. I'll write numbered steps and a short troubleshooting section.",
    prompt:
      "Write clear step-by-step instructions for [process]. The reader is [who will use it]. Here's how it works today: [describe the steps]. Number the steps and add a short troubleshooting section.",
  },
  {
    id: "explain-topic",
    icon: "🎓",
    title: "I can explain a confusing topic in plain language",
    body: "Name the topic. You'll get an everyday example and the three things that matter most.",
    prompt:
      "Explain [topic] to me in plain language, as if I'm new to it. Use an everyday example, then list the three things I most need to remember.",
  },
  {
    id: "proofread",
    icon: "✍️",
    title: "I can proofread a document and explain the fixes",
    body: "Paste your text. I'll fix spelling, grammar, and unclear sentences, then list the changes that matter.",
    prompt:
      "Proofread this text. Fix spelling, grammar, and unclear sentences, then list the most important changes you made and why.\n\nText:\n[paste your text]",
  },
  {
    id: "translate-message",
    icon: "🌐",
    title: "I can translate a message and keep its tone",
    body: "Pick a language and a tone. I'll translate it and point out phrases that don't carry over cleanly.",
    prompt:
      "Translate this message into [language]. Keep the tone [formal or friendly], and point out any phrase that doesn't translate cleanly.\n\nMessage:\n[paste your message]",
  },
  {
    id: "simple-web-page",
    icon: "🧩",
    title: "I can build a simple web page or form",
    body: "Tell me what it's for. I'll build one accessible HTML file in UC San Diego colors and show you how to open it.",
    prompt:
      "Build a simple, accessible web page in this project for [purpose]. It should include [what it needs]. Use UC San Diego colors, keep it to one HTML file, and tell me how to open it.",
  },
  {
    id: "organize-folder",
    icon: "🗂️",
    title: "I can sort out a messy folder of files",
    body: "Point me at a folder. I'll propose clearer folders and file names and wait for your OK before moving anything.",
    prompt:
      "Look at the files in [folder] in this project. Suggest a clearer folder structure and file naming scheme, and show me the plan before you move or rename anything.",
  },
  {
    id: "data-question",
    icon: "🔎",
    title: "Ask me a question about your data",
    body: "Name a file and ask. I'll answer, show how I got there, and tell you if the data can't fully answer it.",
    prompt:
      "Using the file [file name] in this project, answer this question: [your question]. Show how you got the answer, and tell me if the data can't fully answer it.",
  },
  {
    id: "procedure-checklist",
    icon: "✅",
    title: "I can turn a long procedure into a checklist",
    body: "Paste the procedure. I'll group the steps and mark the ones that are easy to miss.",
    prompt:
      "Turn this procedure into a short checklist I can follow each time. Group the steps by phase and mark the ones that are easy to miss.\n\nProcedure:\n[paste it]",
  },
  {
    id: "reply-to-feedback",
    icon: "🤝",
    title: "I can help you reply to feedback or a complaint",
    body: "Paste what they wrote and what you can offer. I'll draft a reply that's professional and warm.",
    prompt:
      "Help me reply to this feedback. I want to acknowledge the concern, explain what we can do, and keep it professional and warm.\n\nFeedback:\n[paste it]\n\nWhat we can offer: [details]",
  },
  {
    id: "brainstorm",
    icon: "🧠",
    title: "Brainstorm with me",
    body: "Tell me the goal. I'll suggest fifteen ideas, safe and bold, and pick the three best.",
    prompt:
      "Brainstorm 15 ideas for [goal]. Mix safe ideas with bold ones, then pick the three best and explain why.",
  },
  {
    id: "report-summary",
    icon: "📑",
    title: "I can summarize a report for busy readers",
    body: "Name the report and audience. You'll get a three-sentence summary, the key numbers, and recommended actions.",
    prompt:
      "Summarize [report name, or paste the text below] for [audience]. Start with a three-sentence summary, then the key numbers, then recommended actions.",
  },
  {
    id: "combine-spreadsheets",
    icon: "🔗",
    title: "I can combine two spreadsheets",
    body: "Name the files and the column they share. I'll merge them and tell you which rows didn't match.",
    prompt:
      "Combine [first file] and [second file] in this project using [the column they share]. Tell me which rows didn't match, then save the combined file next to the originals.",
  },
  {
    id: "accessibility-check",
    icon: "♿",
    title: "I can check a document or page for accessibility",
    body: "Point me at it. I'll check headings, link text, contrast, alt text, and plain language, and list fixes.",
    prompt:
      "Review [document, page, or file] for accessibility problems: headings, link text, color contrast, alt text, and plain language. List each problem with a fix, most important first.",
  },
  {
    id: "project-timeline",
    icon: "⏰",
    title: "I can plan a project timeline",
    body: "Give me the deadline and the main pieces. I'll work backwards, show dependencies, and flag the riskiest step.",
    prompt:
      "Make a timeline for [project]. It must be done by [deadline]. The main pieces are [list]. Work backwards from the deadline, show dependencies, and flag the riskiest step.",
  },
  {
    id: "tritonai-tour",
    icon: "🧑‍🏫",
    title: "Learn what TritonAI can do in five minutes",
    body: "Tell me your job and I'll show three short examples that fit it, then one you can try right away.",
    prompt:
      "Give me a five-minute tour of what you can do in TritonAI. Show three short examples relevant to [my job or team], then suggest one I could try right now.",
  },
  {
    id: "small-script",
    icon: "🐍",
    title: "I can write a small script to save you time",
    body: "Describe the chore. I'll write the script, explain each step, and try it on a copy first.",
    prompt:
      "Write a small script that [what it should do] with the files in this project. Explain each step in plain language, run it on a copy first, and show me the result.",
  },
  {
    id: "interview-questions",
    icon: "🎤",
    title: "I can prepare interview questions",
    body: "Name the role and the skills to assess. Each question comes with what a strong answer looks like.",
    prompt:
      "Write interview questions for a [job title] candidate. Cover [skills to assess]. Include what a strong answer looks like for each.",
  },
  {
    id: "team-newsletter",
    icon: "📰",
    title: "I can draft a team newsletter",
    body: "Paste the updates. I'll write a friendly newsletter with short sections and a closing reminder.",
    prompt:
      "Draft a short team newsletter from these updates: [paste updates]. Give it a friendly opening, short sections with headings, and a closing reminder.",
  },
  {
    id: "faq",
    icon: "🙋",
    title: "I can turn common questions into an FAQ",
    body: "Paste the questions you keep answering. I'll group them and keep each answer short.",
    prompt:
      "Turn these common questions into a clear FAQ with short answers: [paste the questions and what you usually answer]. Group related questions and keep each answer under 80 words.",
  },
  {
    id: "pdf-table",
    icon: "🧾",
    title: "I can pull a table out of a PDF",
    body: "Name the PDF. I'll copy the table into a spreadsheet, check the totals, and flag rows I wasn't sure about.",
    prompt:
      "Extract the table from [PDF name] in this project into a spreadsheet. Keep the column headings, check the totals, and tell me about any rows you weren't sure about.",
  },
  {
    id: "decision-memo",
    icon: "🗒️",
    title: "I can write a one-page decision memo",
    body: "Tell me the topic and what you know. You'll get background, options, a recommendation, and the cost of waiting.",
    prompt:
      "Write a one-page memo asking for a decision on [topic]. Include the background, the options, my recommendation, and what happens if we wait. Here's what I know: [details].",
  },
  {
    id: "thank-you-note",
    icon: "🙏",
    title: "I can write a thank-you note that sounds like you",
    body: "Tell me who and why. I'll make it specific and warm instead of generic.",
    prompt:
      "Write a short thank-you note to [person] for [what they did]. Make it specific and warm, not generic. Here's some detail: [what made it matter].",
  },
  {
    id: "review-code",
    icon: "🐞",
    title: "I can review code for bugs and confusing parts",
    body: "Point me at a file or folder. I'll explain each problem in plain language, most serious first, without changing anything.",
    prompt:
      "Review the code in [file or folder] for bugs and confusing parts. Explain each problem in plain language and suggest a fix, most serious first. Don't change anything yet.",
  },
  {
    id: "project-readme",
    icon: "📘",
    title: "I can explain what a project folder contains",
    body: "I'll look through the folder and write a short README: what's there, how it fits together, how to start.",
    prompt:
      "Look through this project folder and write a short README explaining what's in it, how the pieces fit together, and how to get started.",
  },
  {
    id: "image-alt-text",
    icon: "🏞️",
    title: "I can write alt text for your images",
    body: "Attach or name the images. Each gets concise alt text that describes what matters to the reader.",
    prompt:
      "Write concise, descriptive alt text for these images: [attach or name the images]. Keep each under 125 characters and describe what matters for the reader.",
  },
  {
    id: "plain-language",
    icon: "🗣️",
    title: "I can replace jargon with plain words",
    body: "Paste the text. I'll rewrite it for a general audience, keep it accurate, and keep it about the same length.",
    prompt:
      "Rewrite this text in plain language for a general audience. Replace jargon and acronyms, keep it accurate, and keep it about the same length.\n\nText:\n[paste it]",
  },
];
