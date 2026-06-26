import { Hono } from "hono";
import { marked } from "marked";
import { applyTemplateVars, defaultTemplateVars, loadTemplate, templateDefinitions, type TemplateDefinition } from "../lib/templates.js";

export const site = new Hono();

const primaryOrigin = "https://agentcontract.to";
const cliPackageName = "@bear-ai-dev/agentcontract";
const currentCliVersion = "0.1.14";
const pageTitle = "AgentContract | Contract signing API and CLI for AI agents";
const pageDescription = "AgentContract is a contract signing API and CLI that lets AI agents send approved NDAs, privacy acknowledgements, and contractor agreements for human e-signature.";
const publicTemplateIds = ["mutual-nda", "one-way-nda", "privacy-policy"] as const;
type PublicTemplateId = typeof publicTemplateIds[number];

type PublicSeoPage = {
  path: string;
  title: string;
  description: string;
  eyebrow: string;
  h1: string;
  intro: string;
  proof: string;
  sections: Array<{ heading: string; body: string }>;
};

type BlogPost = {
  slug: string;
  title: string;
  description: string;
  published: string;
  publishedIso?: string;
  readTime: string;
  keyword?: string;
  dataForSeo?: {
    searchVolume?: number;
    cpc?: number;
    competition?: string;
  };
  h1: string;
  intro: string;
  sections: Array<{ heading: string; paragraphs: string[]; bullets?: string[] }>;
  faqs?: Array<{ question: string; answer: string }>;
  sources?: Array<{ label: string; href: string }>;
  internalLinks?: Array<{ label: string; href: string }>;
};

const publicSeoPages: PublicSeoPage[] = [
  {
    path: "/ai-agent-contracts",
    title: "AI Agent Contracts | AgentContract",
    description: "Use AgentContract to send contracts for AI agents while keeping approved legal language, human review, and human signatures in the loop.",
    eyebrow: "AI Agent Contracts",
    h1: "AI agent contracts that humans still control",
    intro: "AgentContract gives software agents a narrow contract workflow: inspect approved packets, fill known variables, send signing links, and report status. It is built for contracts for AI agents without making the agent a signer, lawyer, or contract author.",
    proof: "Agents send approved NDAs, privacy acknowledgements, contractor agreements, and marketplace onboarding packets. People review and sign them.",
    sections: [
      {
        heading: "What an AI agent is allowed to do",
        body: "The agent can select an approved template, pass recipient details, run a dry run, send the packet, remind the signer, and download the signed record. The agent does not rewrite terms or decide whether someone should sign."
      },
      {
        heading: "What your team gets back",
        body: "Your workflow receives status, audit events, signed PDF bytes, SHA-256 hashes, and webhook callbacks so the next automation step can continue with a verifiable record."
      },
      {
        heading: "Where this fits",
        body: "Use it for marketplace onboarding, vendor packets, contractor agreements, privacy acknowledgements, and repeatable internal paperwork where the same approved language is sent many times."
      }
    ]
  },
  {
    path: "/contract-sending-api",
    title: "Contract Sending API for AI Agents | AgentContract",
    description: "A contract sending API for AI agents, scripts, and backend workflows that need to send approved agreements and receive signed records.",
    eyebrow: "Contract Sending API",
    h1: "Contract sending API for agent workflows",
    intro: "AgentContract exposes API and CLI rails to send approved contracts from an AI agent without turning the model into a legal drafter. Your backend controls templates, recipients, metadata, webhooks, and completion records.",
    proof: "Use the API when an onboarding workflow needs a contract sent now and a signed PDF returned later.",
    sections: [
      {
        heading: "Create agreements from approved packets",
        body: "Send template ids, known variables, signer fields, recipients, and metadata. AgentContract creates a signing link and records every meaningful status change."
      },
      {
        heading: "Track completion by machine",
        body: "Poll agreement status or receive signed webhook callbacks when the signer completes, cancels, or needs follow-up. Signed PDFs and hashes remain tied to the agreement."
      },
      {
        heading: "Keep private workflows private",
        body: "Dashboards, signing links, auth routes, and API routes stay out of the sitemap and robots allowlist while public product and documentation pages remain indexable."
      }
    ]
  },
  {
    path: "/agent-contract-cli",
    title: "Agent Contract CLI | AgentContract",
    description: "Install the AgentContract CLI so local AI coding agents can inspect templates, send approved contracts, and track signed records.",
    eyebrow: "Agent Contract CLI",
    h1: "Agent contract CLI for local AI workflows",
    intro: "The agentcontract CLI lets Claude Code, Codex, scripts, and other local agent workflows read approved packets, dry-run sends, authenticate with email codes, and track agreements from the terminal.",
    proof: "Install the agentcontract CLI, run the agent skill command, then give your local agent a controlled contract-sending tool.",
    sections: [
      {
        heading: "Built for local agents",
        body: "The CLI prints structured JSON, supports dry runs, saves login config locally, and gives agents explicit commands for reading, sending, reminding, cancelling, and reporting failures."
      },
      {
        heading: "Human-signature boundary",
        body: "Local agents can prepare and send approved packets, but the recipient signs in the browser. AgentContract keeps the contract action separate from model reasoning."
      },
      {
        heading: "Fast first test",
        body: "A tester can install from the hosted CLI page, log in with an email code, run doctor, inspect templates, and send a dry-run marketplace onboarding packet."
      }
    ]
  },
  {
    path: "/esignature-for-ai-agents",
    title: "E-signature for AI Agents | AgentContract",
    description: "AgentContract provides e-signature for AI agents that send approved packets while humans review, consent, and sign in the browser.",
    eyebrow: "E-signature for AI Agents",
    h1: "E-signature for AI agents, with people in the signing loop",
    intro: "AgentContract gives agent workflows an e-signature path that keeps the final human action explicit. Agents can send the packet. People review the document, consent, type or draw a signature, and submit the signed record.",
    proof: "Use e-signature for AI agents when automation should move paperwork forward but not replace the human signer.",
    sections: [
      {
        heading: "Browser signing pages",
        body: "Recipients open a signing URL, review the agreement, complete required fields, consent to electronic signature, and submit the signed packet."
      },
      {
        heading: "Executed records",
        body: "After completion, AgentContract stores signer fields, audit events, signed PDF bytes, completion timestamps, and SHA-256 hashes for later verification."
      },
      {
        heading: "Agent-safe workflow design",
        body: "The product avoids legal advice and contract drafting. It focuses on controlled delivery, human review, human signature, and machine-readable completion."
      }
    ]
  }
];

const blogPosts: BlogPost[] = [
  {
    slug: "ai-agents-send-contracts-humans-sign",
    title: "AI agents can send contracts. Humans still need to sign. | AgentContract Blog",
    description: "A practical boundary for AI agent contract workflows: agents prepare and send approved packets, while humans review and sign.",
    published: "June 5, 2026",
    readTime: "5 min read",
    h1: "AI agents can send contracts. Humans still need to sign.",
    intro: "The useful boundary is simple: agents prepare and send approved packets; people review and sign. AgentContract exists for that narrow handoff.",
    sections: [
      {
        heading: "The wrong question is whether an agent can sign",
        paragraphs: [
          "Most teams do not need an AI agent to become a legal actor. They need the agent to move repeatable paperwork forward without making new legal choices. The agent can collect recipient details, choose an approved template, run a dry run, and send the packet once a human operator has approved the send.",
          "That is very different from letting the agent draft terms, negotiate risk, or consent on behalf of a company. The product boundary should be visible in the workflow: the contract language is approved before the agent touches it, and the final signature comes from a person in the browser."
        ]
      },
      {
        heading: "The agent should handle ceremony, not judgment",
        paragraphs: [
          "Contract workflows have many mechanical steps: pick the packet, fill known variables, email the signer, track status, send reminders, and download the executed record. Those are good jobs for software agents because they are repetitive and easy to audit.",
          "The judgment steps stay human. Someone decides which packet applies, whether the recipient should receive it, whether the dry-run output is acceptable, and whether a signed document should unblock the next business action."
        ]
      },
      {
        heading: "A safe workflow has a dry run",
        paragraphs: [
          "A dry run turns the agent's plan into inspectable JSON before any email goes out. The human can see the recipient, template, fields, webhook metadata, and document title. If something looks wrong, nothing has been sent yet.",
          "That checkpoint matters because agents are fast. A fast mistake in a contract workflow is still a contract workflow mistake. Dry-run-first keeps speed from becoming surprise."
        ]
      },
      {
        heading: "The output should be machine-readable",
        paragraphs: [
          "After a human signs, the next system needs more than a screenshot. It needs a status, signed PDF, completion timestamp, audit events, and a hash that can be stored beside the application's own record.",
          "That is the shape AgentContract optimizes for: agent sends approved packet, human signs, application receives a durable record."
        ]
      }
    ]
  },
  {
    slug: "contract-sending-api-for-agent-workflows",
    title: "How to design a contract sending API for agent workflows | AgentContract Blog",
    description: "What changes when a contract sending API is designed for AI agents, scripts, and backend workflows instead of only human dashboards.",
    published: "June 5, 2026",
    readTime: "6 min read",
    h1: "How to design a contract sending API for agent workflows.",
    intro: "A contract sending API for agents needs stricter rails than a human-first e-signature dashboard. It should be boring, explicit, and easy to audit.",
    sections: [
      {
        heading: "Start with approved packets",
        paragraphs: [
          "The API should not ask the agent to invent legal language. It should ask for a template id, a recipient, known variables, optional metadata, and a webhook destination. The packet is already approved; the agent only supplies the operational context.",
          "That single choice removes a large class of failures. If the agent cannot rewrite terms, the API does not need to guess whether a generated clause is acceptable."
        ]
      },
      {
        heading: "Make the request inspectable",
        paragraphs: [
          "Every send command should have a dry-run equivalent. In an agent workflow, dry runs are not a developer convenience; they are the approval surface. The human operator needs to inspect exactly what will be sent before the agent takes the irreversible step.",
          "The response should include the chosen template, resolved recipient, field list, metadata, and the endpoint that would receive the real request. If the dry run is hard to read, the human will skip it."
        ]
      },
      {
        heading: "Return records, not vibes",
        paragraphs: [
          "Once the agreement exists, the API should return stable identifiers and status. Once it is signed, it should return the signed PDF, a SHA-256 hash, structured field values, and audit events.",
          "Agents and backend jobs are good at continuing from structured state. They are bad at interpreting ambiguous UI states like, \"it probably sent.\" Good contract APIs should never require that kind of guess."
        ]
      },
      {
        heading: "Build in cancellation and key revocation",
        paragraphs: [
          "Agent workflows need an obvious stop button. If a key starts sending the wrong packet, revoking that key should stop future sends and make it easy to cancel in-flight agreements associated with that key.",
          "Rate limits, ownership metadata, and audit events are not polish. They are the controls that make it reasonable to let an agent operate in a workflow that touches legal documents."
        ]
      }
    ]
  },
  {
    slug: "agent-contract-cli-playbook",
    title: "A CLI playbook for agent-native contract sending | AgentContract Blog",
    description: "A practical CLI workflow for letting local AI coding agents inspect, dry-run, send, and track approved contract packets.",
    published: "June 5, 2026",
    readTime: "5 min read",
    h1: "A CLI playbook for agent-native contract sending.",
    intro: "The best agent contract workflow starts with a terminal command that is boring on purpose. Boring commands are easier for humans to inspect and easier for agents to repeat.",
    sections: [
      {
        heading: "Install, authenticate, then print the agent skill",
        paragraphs: [
          "A local agent should not need private dashboard context to understand how to send paperwork. The CLI should install, authenticate with an email code, and print a compact skill that tells the agent what it may and may not do.",
          "That skill should say the quiet part clearly: inspect templates first, run dry runs, wait for human approval, send only approved packets, and report failures immediately."
        ]
      },
      {
        heading: "Read before sending",
        paragraphs: [
          "A good playbook asks the agent to list templates, read the chosen template, and show the dry-run output before sending. This keeps the human in the approval loop without making the human click through a dashboard for every mechanical step.",
          "For custom packets, the same pattern applies. Save the draft locally, capture feedback, revise, read the final version, and only then prepare the send."
        ]
      },
      {
        heading: "Track from the terminal",
        paragraphs: [
          "After sending, the agent should be able to check status, view audit events, remind the signer, cancel the agreement, and download the signed PDF. These commands let the agent complete the workflow without pretending the dashboard is the product.",
          "The dashboard can still be useful for humans. The CLI is the operational surface for the agent."
        ]
      },
      {
        heading: "Capture feedback at the failure point",
        paragraphs: [
          "When install, login, or sending breaks, the best time to capture feedback is while the failed command is still on screen. A CLI feedback command can store the exact command, expected result, actual result, and severity.",
          "That turns agent failure into product telemetry instead of a vague Slack message. It also gives the next agent enough context to fix the workflow."
        ]
      }
    ]
  }
];

const dataForSeoBlogPosts: BlogPost[] = [
  {
    slug: "esignature-api-for-ai-agent-workflows",
    title: "What should an eSignature API do for AI agent workflows? | AgentContract Blog",
    description: "A practical eSignature API checklist for AI agent workflows that send approved agreements while humans review and sign.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "7 min read",
    keyword: "esignature api",
    dataForSeo: { searchVolume: 110, cpc: 38.33, competition: "MEDIUM" },
    h1: "What should an eSignature API do for AI agent workflows?",
    intro: "An eSignature API for AI agent workflows should make sending explicit, auditable, and human-controlled. The agent can prepare and send an approved agreement, but a person still reviews the document and signs in the browser.",
    sections: [
      {
        heading: "The API should narrow the agent's job",
        paragraphs: [
          "Most eSignature API pages are written for developers building general document workflows. Agent workflows need a narrower promise. The agent should select an approved packet, fill known variables, run a dry run, and create a signing link only after the operator accepts the send.",
          "That boundary matters because contracts are not ordinary notifications. If the API lets the agent generate legal language, pick risky terms, or treat a signature as a background task, the workflow becomes hard to trust. A safer eSignature API makes the irreversible step visible."
        ],
        bullets: [
          "Approved templates live outside the model prompt.",
          "Dry runs show recipient, template, fields, metadata, and webhook target.",
          "The signer reviews and consents in a browser, not inside an agent transcript.",
          "The completed record returns status, audit events, PDF bytes, and hashes."
        ]
      },
      {
        heading: "The best response is structured state",
        paragraphs: [
          "A human dashboard can get away with visual cues. An agent workflow cannot. The API should return stable agreement ids, signing URLs, status values, timestamps, and webhook events that downstream code can reason about.",
          "This is also how you avoid vague agent summaries like \"it looks sent.\" The agent should be able to say which agreement was created, who received it, whether a reminder went out, and whether a signed PDF is available."
        ]
      },
      {
        heading: "Use the API for ceremony, not legal judgment",
        paragraphs: [
          "The useful automation is the ceremony around the agreement: preparing the packet, sending the email, tracking status, reminding the recipient, and storing the executed record. The legal judgment stays with the people who approved the template and the signer who signs.",
          "AgentContract is intentionally shaped around that operating model. It gives agents an API and CLI path for approved packets, while the human review and signature remain explicit."
        ]
      }
    ],
    faqs: [
      {
        question: "Can an AI agent sign through an eSignature API?",
        answer: "AgentContract is designed for the opposite boundary: agents can prepare and send approved packets, while humans review and sign. That keeps consent, authorization, and audit responsibility visible."
      },
      {
        question: "What should I log when an agent sends an agreement?",
        answer: "Log the template id, recipient, dry-run approval, agreement id, status changes, signer events, signed PDF hash, and webhook delivery attempts."
      }
    ],
    sources: [
      { label: "DocuSign eSignature REST API", href: "https://developers.docusign.com/docs/esign-rest-api/" },
      { label: "PandaDoc explanation of eSignature APIs", href: "https://www.pandadoc.com/blog/what-is-esignature-api/" },
      { label: "BoldSign eSignature API", href: "https://boldsign.com/esignature-api/" }
    ],
    internalLinks: [
      { label: "Contract sending API", href: "/contract-sending-api" },
      { label: "AgentContract CLI", href: "/agent-contract-cli" },
      { label: "Docs", href: "/docs" }
    ]
  },
  {
    slug: "contract-signing-api-checklist",
    title: "What is a contract signing API checklist for agent-triggered sends? | AgentContract Blog",
    description: "A contract signing API checklist for teams that want agents and backend jobs to send approved contracts without losing human control.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "6 min read",
    keyword: "contract signing api",
    h1: "What is a contract signing API checklist for agent-triggered sends?",
    intro: "A contract signing API for agent-triggered sends should be judged by its guardrails: approved templates, dry runs, signer consent, audit events, webhooks, and downloadable signed records.",
    sections: [
      {
        heading: "Start with the approval surface",
        paragraphs: [
          "If an agent can send a contract, the approval surface needs to be simple enough for a person to inspect quickly. The dry-run response should show exactly what will be sent before the API creates a real signing link.",
          "The most important checklist item is not a feature checkbox. It is whether the product makes the agent's intended action understandable to the operator."
        ],
        bullets: [
          "Template id and template name are visible.",
          "Recipient name and email are visible.",
          "Resolved variables are visible.",
          "Metadata and webhook target are visible.",
          "No email is sent during the dry run."
        ]
      },
      {
        heading: "Then check the completion record",
        paragraphs: [
          "The API should return enough state for a backend job or agent to continue without scraping a dashboard. After signature, the system should expose status, signed PDF, field values, audit events, timestamps, and a hash.",
          "This is where many general-purpose signing workflows become awkward for agents. If the next step depends on a human checking a dashboard, the automation chain is brittle."
        ]
      },
      {
        heading: "Finally, check the stop buttons",
        paragraphs: [
          "Agent-triggered systems need obvious ways to revoke keys, cancel agreements, and inspect every action tied to a key or user. A mistake should be containable.",
          "AgentContract keeps those controls close to the workflow: dry run before send, status after send, reminders and cancellation after creation, and signed records after completion."
        ]
      }
    ],
    faqs: [
      {
        question: "What makes a contract signing API agent-safe?",
        answer: "It limits the agent to approved packets, requires inspectable dry runs, keeps humans in the signature step, and returns machine-readable completion records."
      },
      {
        question: "Should the agent choose contract language?",
        answer: "No. The safer pattern is approved contract language first, then agent-assisted delivery and tracking."
      }
    ],
    internalLinks: [
      { label: "API docs", href: "/docs#api" },
      { label: "AI agent contracts", href: "/ai-agent-contracts" },
      { label: "Templates", href: "/templates" }
    ]
  },
  {
    slug: "document-signing-api-vs-dashboard",
    title: "When should you use a document signing API instead of a dashboard? | AgentContract Blog",
    description: "Use a document signing API when contract sending is part of a repeatable backend, CLI, or AI agent workflow, not a one-off dashboard task.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "6 min read",
    keyword: "document signing api",
    dataForSeo: { searchVolume: 50, cpc: 37.74, competition: "MEDIUM" },
    h1: "When should you use a document signing API instead of a dashboard?",
    intro: "Use a document signing API when the sender is a system: a backend job, CLI, onboarding workflow, or AI agent that needs to send approved documents and react to signed records.",
    sections: [
      {
        heading: "Dashboards are good for one-off judgment",
        paragraphs: [
          "A dashboard is excellent when a person is manually assembling a packet, choosing recipients, and making case-by-case decisions. It is less useful when the same approved packet needs to be sent many times from a product workflow.",
          "Agent workflows expose this difference quickly. The agent should not click around a dashboard. It should call a narrow API, print the dry-run state, wait for approval, and then send."
        ]
      },
      {
        heading: "APIs are better for repeatable state",
        paragraphs: [
          "The API should preserve the state that automation needs: agreement ids, status, signer events, completion timestamps, signed PDFs, and hashes. Those fields make the contract step part of the product workflow instead of a manual side quest.",
          "That is especially valuable for onboarding. A marketplace can create the contributor record, send a privacy acknowledgement, wait for signature, and unlock the next step only after the signed record exists."
        ],
        bullets: [
          "Use dashboards for exceptions.",
          "Use APIs for repeatable approved sends.",
          "Use webhooks when the next step depends on signature.",
          "Use hashes and audit events when records need to be verified later."
        ]
      },
      {
        heading: "The API should still respect the human signer",
        paragraphs: [
          "A document signing API should not hide the act of signing. The recipient should open a clear signing page, review the document, consent to electronic signature, and submit the signed packet.",
          "The point of the API is not to remove humans from contracts. It is to remove the copy-paste work around contracts."
        ]
      }
    ],
    faqs: [
      {
        question: "Is a document signing API only for large companies?",
        answer: "No. Small teams benefit when the same approved agreement is sent often enough that manual dashboard work slows onboarding or creates tracking gaps."
      },
      {
        question: "What is the first document to automate?",
        answer: "Start with a low-variance packet such as a privacy acknowledgement, NDA, or contractor agreement that already has approved language."
      }
    ],
    sources: [
      { label: "DocuSign eSignature REST API", href: "https://developers.docusign.com/docs/esign-rest-api/" },
      { label: "SignatureAPI developer site", href: "https://signatureapi.com/" }
    ],
    internalLinks: [
      { label: "Contract sending API", href: "/contract-sending-api" },
      { label: "CLI", href: "/cli" },
      { label: "Template library", href: "/templates" }
    ]
  },
  {
    slug: "api-to-send-documents-for-signature",
    title: "How do you send documents for signature from an AI agent? | AgentContract Blog",
    description: "A safe API pattern for sending documents for signature from an AI agent: inspect, dry-run, approve, send, track, and store the signed record.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "7 min read",
    keyword: "api to send documents for signature",
    h1: "How do you send documents for signature from an AI agent?",
    intro: "The safe pattern is inspect, dry-run, approve, send, track, and store. An API to send documents for signature should make each step visible before a real signer receives anything.",
    sections: [
      {
        heading: "Step 1: inspect the approved packet",
        paragraphs: [
          "The agent should begin by reading the template or packet definition. This confirms the document is approved, the variables are known, and the agent is not inventing terms inside a prompt.",
          "In AgentContract, the CLI and API both support this operating style. The agent can inspect templates and show the human what packet it intends to use."
        ]
      },
      {
        heading: "Step 2: dry-run the send",
        paragraphs: [
          "A dry run is the approval moment. It should return the resolved recipient, template, variables, metadata, and proposed send action without emailing the signer.",
          "For agent workflows, this is more important than a confirmation modal. The dry-run output can be copied into the conversation, reviewed by a person, and approved explicitly."
        ],
        bullets: [
          "Recipient is correct.",
          "Template is correct.",
          "Variable values are correct.",
          "Webhook metadata is correct.",
          "The operator approves the real send."
        ]
      },
      {
        heading: "Step 3: track until completion",
        paragraphs: [
          "After sending, the agent should report the agreement id and status. It should be able to remind, cancel, or download the signed PDF without asking the user to hunt through a dashboard.",
          "The end state should be a signed record, not just an email that was sent. That record is what lets the next onboarding or compliance step continue."
        ]
      }
    ],
    faqs: [
      {
        question: "Can the API send custom documents?",
        answer: "A safe first version should prefer approved packets and known variables. Custom document support should still require review before sending."
      },
      {
        question: "What should the agent return after sending?",
        answer: "Return the agreement id, recipient, status, signing URL if appropriate, and the next tracking command or webhook expectation."
      }
    ],
    internalLinks: [
      { label: "Docs", href: "/docs" },
      { label: "AgentContract CLI", href: "/agent-contract-cli" },
      { label: "AI agent contracts", href: "/ai-agent-contracts" }
    ]
  },
  {
    slug: "docusign-api-alternative-for-agent-workflows",
    title: "What is a DocuSign API alternative for agent workflows? | AgentContract Blog",
    description: "A DocuSign API alternative for AI agent workflows should optimize for approved packets, dry runs, CLI use, and simple signed-record retrieval.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "6 min read",
    keyword: "docusign api alternative",
    dataForSeo: { searchVolume: 10, competition: "HIGH" },
    h1: "What is a DocuSign API alternative for agent workflows?",
    intro: "A DocuSign API alternative for agent workflows is not just a cheaper signature tool. It is a narrower signing workflow built for agents, scripts, and backend jobs that send approved packets.",
    sections: [
      {
        heading: "The alternative question is about workflow fit",
        paragraphs: [
          "DocuSign is a broad e-signature platform with mature API coverage. Some teams need that breadth. Agent workflows often need something smaller: a controlled API surface where agents can inspect, dry-run, send, and track a limited set of approved agreements.",
          "If the product question is \"how do we let a coding agent send one approved onboarding packet safely,\" a narrow tool can be easier to reason about than a broad enterprise suite."
        ]
      },
      {
        heading: "Look for agent-native controls",
        paragraphs: [
          "The most important controls are not exotic. They are dry runs, readable JSON, CLI support, simple authentication, audit events, cancellation, reminders, and signed PDF retrieval.",
          "Those controls are what let a human operator trust the agent's work without sitting inside a separate dashboard for every send."
        ],
        bullets: [
          "Can the agent inspect templates before sending?",
          "Can the agent run a no-email dry run?",
          "Can a human approve from terminal output?",
          "Can the agent fetch signed records later?",
          "Can API keys be revoked quickly?"
        ]
      },
      {
        heading: "Choose narrow when the contract set is narrow",
        paragraphs: [
          "If your workflow only sends a few approved packets, the product should feel constrained. NDAs, privacy acknowledgements, and contractor agreements do not need a model to be creative.",
          "AgentContract is positioned for that narrow lane: approved contract packets sent by agents, signed by humans, and returned as structured records."
        ]
      }
    ],
    faqs: [
      {
        question: "Is AgentContract a full DocuSign replacement?",
        answer: "No. It is focused on agent-sent, human-signed approved packets. Broad enterprise document suites cover many workflows AgentContract does not try to cover."
      },
      {
        question: "When is a narrow signing API better?",
        answer: "When the documents are repeatable, the language is pre-approved, and the main job is controlled sending, tracking, and signed-record retrieval."
      }
    ],
    sources: [
      { label: "DocuSign eSignature REST API", href: "https://developers.docusign.com/docs/esign-rest-api/" },
      { label: "Eversign eSignature API", href: "https://eversign.com/api" },
      { label: "BoldSign eSignature API", href: "https://boldsign.com/esignature-api/" }
    ],
    internalLinks: [
      { label: "CLI playbook", href: "/blog/agent-contract-cli-playbook" },
      { label: "Contract sending API", href: "/contract-sending-api" },
      { label: "Docs", href: "/docs" }
    ]
  },
  {
    slug: "contract-automation-software-for-repeatable-packets",
    title: "What should contract automation software automate? | AgentContract Blog",
    description: "Contract automation software should automate repeatable ceremony around approved packets, not legal judgment, negotiation, or consent.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "7 min read",
    keyword: "contract automation software",
    dataForSeo: { searchVolume: 140, cpc: 293.36, competition: "LOW" },
    h1: "What should contract automation software automate?",
    intro: "Contract automation software should automate repeatable ceremony: packet selection, variable filling, sending, reminders, status tracking, webhooks, and signed-record storage. It should not automate legal judgment or human consent.",
    sections: [
      {
        heading: "Automate the parts that are already decided",
        paragraphs: [
          "The safest contract automation starts after the organization has already decided which language is approved. Once the packet is approved, software can fill known variables, send it to the right recipient, and track completion.",
          "This is a good fit for AI agents because the task is operational. The agent can handle a queue of sends, but it should not decide whether the terms are acceptable."
        ],
        bullets: [
          "Template selection from an approved list.",
          "Recipient and variable entry.",
          "Dry-run output for human approval.",
          "Signing link creation.",
          "Reminder, cancellation, and status commands.",
          "Signed PDF and audit event retrieval."
        ]
      },
      {
        heading: "Do not automate away consent",
        paragraphs: [
          "The signature step should stay human and visible. A person should review the agreement, consent to electronic signature, and submit the signed record.",
          "That is not a weakness in the automation. It is the control that makes the automation usable for legal-adjacent workflows."
        ]
      },
      {
        heading: "Measure automation by fewer dropped packets",
        paragraphs: [
          "The business value is not just speed. It is fewer forgotten onboarding packets, fewer missing signed records, fewer status-check messages, and cleaner audit trails.",
          "For small teams, that is often enough. A narrow contract automation workflow can remove the tedious parts without turning the product into a full contract lifecycle system."
        ]
      }
    ],
    faqs: [
      {
        question: "Should contract automation software draft terms?",
        answer: "For agent workflows, drafting should be outside the send path. Use approved packets and keep legal review separate from delivery automation."
      },
      {
        question: "What is the highest-value first automation?",
        answer: "Automate a repeatable packet with clear approval rules, such as a marketplace privacy acknowledgement, NDA, or contractor agreement."
      }
    ],
    internalLinks: [
      { label: "Contract sending API", href: "/contract-sending-api" },
      { label: "Templates", href: "/templates" },
      { label: "E-signature for AI agents", href: "/esignature-for-ai-agents" }
    ]
  },
  {
    slug: "contract-management-api-for-small-teams",
    title: "What contract management API features do small teams actually need? | AgentContract Blog",
    description: "Small teams need a contract management API that sends approved packets, tracks status, stores signed records, and avoids unnecessary CLM complexity.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "6 min read",
    keyword: "contract management api",
    dataForSeo: { searchVolume: 10, competition: "LOW" },
    h1: "What contract management API features do small teams actually need?",
    intro: "A small-team contract management API should focus on the loop that matters: create an agreement from an approved packet, send it, track it, and retrieve the signed record.",
    sections: [
      {
        heading: "Avoid buying a system for a workflow you do not have",
        paragraphs: [
          "Contract lifecycle management platforms can be valuable when a company has negotiation workflows, approvals, clause libraries, redlines, procurement controls, and renewal management. Many small teams are not there yet.",
          "Their immediate problem is simpler: they need to send the same few packets, prove who signed, and keep the product workflow moving."
        ]
      },
      {
        heading: "Minimum useful API surface",
        paragraphs: [
          "The API should expose templates, agreement creation, status polling, webhooks, reminders, cancellation, audit events, and signed PDF retrieval. That is the surface area an agent or backend workflow can use without dashboard dependence.",
          "Anything beyond that should earn its complexity. If the system makes the common send path harder, it is not helping the team ship."
        ],
        bullets: [
          "List approved templates.",
          "Create agreement from template.",
          "Run dry-run validation.",
          "Send agreement.",
          "Read status and audit events.",
          "Download signed PDF.",
          "Receive completion webhook."
        ]
      },
      {
        heading: "Make it boring enough for agents",
        paragraphs: [
          "Agents do best with boring APIs. Stable ids, clear status strings, JSON responses, and deterministic errors are more useful than a highly flexible workflow hidden behind a dashboard.",
          "AgentContract keeps the API small on purpose so a local agent, CLI script, or backend job can understand the contract step and report it accurately."
        ]
      }
    ],
    faqs: [
      {
        question: "Do small teams need contract lifecycle management?",
        answer: "Sometimes, but many first need controlled sending and signed-record storage for a handful of approved packets."
      },
      {
        question: "What API feature matters most after sending?",
        answer: "Signed-record retrieval matters most: status, timestamps, audit events, signed PDF, and hash."
      }
    ],
    internalLinks: [
      { label: "API docs", href: "/docs#api" },
      { label: "AgentContract CLI", href: "/cli" },
      { label: "Agreement workflow post", href: "/blog/contract-sending-api-for-agent-workflows" }
    ]
  },
  {
    slug: "vendor-onboarding-process-contracts",
    title: "How do you improve the vendor onboarding process with contract packets? | AgentContract Blog",
    description: "Improve the vendor onboarding process by turning repeatable paperwork into approved packets with dry runs, signing links, status, and audit trails.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "6 min read",
    keyword: "vendor onboarding process",
    dataForSeo: { searchVolume: 170, cpc: 15.82, competition: "LOW" },
    h1: "How do you improve the vendor onboarding process with contract packets?",
    intro: "The vendor onboarding process improves when repeatable paperwork becomes an approved packet: the system sends it, the vendor signs it, and your workflow receives a clear completion record.",
    sections: [
      {
        heading: "Find the repeatable packet first",
        paragraphs: [
          "Vendor onboarding usually includes several documents, but not all of them should be automated at once. Start with the packet that is sent repeatedly with minimal variation, such as an NDA, privacy acknowledgement, or standard contractor agreement.",
          "That packet should have approved language, known variables, and a clear rule for when it should be sent."
        ]
      },
      {
        heading: "Put the packet behind a dry run",
        paragraphs: [
          "A dry run lets the operator inspect the vendor name, email, template, variables, and metadata before a real signing email goes out. This is useful for people and essential for agents.",
          "Once the operator approves the dry run, the agent can send the packet and keep tracking it without asking someone to check a dashboard."
        ],
        bullets: [
          "Vendor details are checked before send.",
          "The correct packet is selected.",
          "Metadata links the agreement to the vendor record.",
          "Webhooks unlock the next onboarding step after signature."
        ]
      },
      {
        heading: "Use the signed record as the gate",
        paragraphs: [
          "The onboarding workflow should not move forward because someone thinks an email was sent. It should move forward because the signed record exists.",
          "That signed record should include completion timestamp, signer details, audit events, PDF bytes, and hash. Those fields make vendor onboarding easier to prove later."
        ]
      }
    ],
    faqs: [
      {
        question: "Which vendor onboarding document should be automated first?",
        answer: "Pick a low-variance, high-frequency packet that already has approved language and blocks the next workflow step when missing."
      },
      {
        question: "Can an agent manage vendor reminders?",
        answer: "Yes, if reminders are tied to agreement status and the agent reports each reminder attempt clearly."
      }
    ],
    internalLinks: [
      { label: "One-way NDA template", href: "/templates/one-way-nda" },
      { label: "Contract sending API", href: "/contract-sending-api" },
      { label: "Docs", href: "/docs" }
    ]
  },
  {
    slug: "marketplace-onboarding-contract-workflow",
    title: "How should marketplaces handle onboarding contracts? | AgentContract Blog",
    description: "Marketplace onboarding contracts work best as approved packets for contributors, vendors, or partners, with human signatures and machine-readable records.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "6 min read",
    keyword: "marketplace onboarding",
    dataForSeo: { searchVolume: 10, competition: "LOW" },
    h1: "How should marketplaces handle onboarding contracts?",
    intro: "Marketplaces should handle onboarding contracts as approved packets: send the right document to the right participant, collect a human signature, and store the record beside the marketplace account.",
    sections: [
      {
        heading: "Marketplace paperwork is usually repeatable",
        paragraphs: [
          "Contributor, vendor, and partner onboarding often repeats the same legal-adjacent documents. Privacy acknowledgements, NDAs, contractor agreements, and platform terms are sent again and again.",
          "That repeatability is exactly what makes the workflow a good fit for an API or CLI. The agent does not need to create terms. It needs to send the approved packet accurately."
        ]
      },
      {
        heading: "Tie every agreement to the marketplace record",
        paragraphs: [
          "The agreement metadata should include the marketplace participant id, workflow step, source, and any internal owner needed for follow-up. That makes the signed record easy to reconcile after completion.",
          "When the signer completes the packet, the webhook can mark the onboarding step complete and let the product continue."
        ],
        bullets: [
          "Contributor account id.",
          "Packet type.",
          "Sender or workflow owner.",
          "Completion webhook target.",
          "Signed PDF hash."
        ]
      },
      {
        heading: "Keep the signer experience plain",
        paragraphs: [
          "Marketplace participants should not need to understand your internal automation. They should receive a clear signing link, review the document, consent to electronic signature, and submit.",
          "The backend and agents can handle the machinery around that human action. The signature itself should stay boring and obvious."
        ]
      }
    ],
    faqs: [
      {
        question: "Can marketplace onboarding contracts be sent in bulk?",
        answer: "Yes, if each send still uses approved templates, validated recipient data, and a clear status trail for each agreement."
      },
      {
        question: "What should happen after a contributor signs?",
        answer: "The marketplace should receive a webhook, store the signed record, and unlock the next onboarding step."
      }
    ],
    internalLinks: [
      { label: "Privacy policy template", href: "/templates/privacy-policy" },
      { label: "CLI", href: "/agent-contract-cli" },
      { label: "AI agent contracts", href: "/ai-agent-contracts" }
    ]
  },
  {
    slug: "contractor-agreement-template-agent-workflow",
    title: "How should agents use a contractor agreement template? | AgentContract Blog",
    description: "Agents should use a contractor agreement template only after the language is approved, variables are checked, and a human approves the send.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "7 min read",
    keyword: "contractor agreement template",
    dataForSeo: { searchVolume: 1600, cpc: 6.15, competition: "HIGH" },
    h1: "How should agents use a contractor agreement template?",
    intro: "An agent should use a contractor agreement template as an approved packet, not as a drafting playground. The safe workflow is review the template, fill known variables, dry-run the send, get human approval, and collect the contractor's signature.",
    sections: [
      {
        heading: "Do not let the agent classify the relationship",
        paragraphs: [
          "Contractor agreements can touch worker classification, payment terms, IP, confidentiality, and tax workflows. Those are human and counsel decisions. The agent should not decide whether someone is properly treated as a contractor.",
          "The agent's role starts after the organization has selected the right approved template for the situation."
        ]
      },
      {
        heading: "Use variables that are easy to inspect",
        paragraphs: [
          "The dry run should show the contractor name, email, company name, effective date, role or project label, and any other approved variables. If a field requires judgment, do not hide that judgment inside the agent prompt.",
          "This keeps the template reusable without pretending every contractor relationship is the same."
        ],
        bullets: [
          "Recipient name and email.",
          "Company legal name.",
          "Effective date.",
          "Project or role label.",
          "Compensation fields only if already approved.",
          "Webhook metadata for onboarding."
        ]
      },
      {
        heading: "Store the signed agreement where onboarding can find it",
        paragraphs: [
          "After signature, the workflow should store the signed PDF and hash next to the contractor record. The agent can then report that the agreement is complete and the next onboarding step can proceed.",
          "This is the point of using an API instead of ad hoc email attachments: the signed record becomes structured workflow state."
        ]
      }
    ],
    faqs: [
      {
        question: "Is this legal advice about contractor agreements?",
        answer: "No. Use counsel-approved templates and classification guidance. AgentContract focuses on controlled sending and signed-record handling."
      },
      {
        question: "Why target contractor agreement template searches?",
        answer: "DataForSEO showed strong demand for contractor agreement template terms. AgentContract should capture that demand with a safe workflow angle instead of generic template advice."
      }
    ],
    sources: [
      { label: "IRS independent contractor guidance", href: "https://www.irs.gov/businesses/small-businesses-self-employed/independent-contractor-defined" }
    ],
    internalLinks: [
      { label: "Templates", href: "/templates" },
      { label: "Contract sending API", href: "/contract-sending-api" },
      { label: "Docs", href: "/docs" }
    ]
  },
  {
    slug: "mutual-nda-template-before-you-send",
    title: "What should you check before sending a mutual NDA template? | AgentContract Blog",
    description: "Before sending a mutual NDA template, check the parties, confidential information scope, term, exclusions, governing law, and signing authority.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "6 min read",
    keyword: "mutual nda template",
    dataForSeo: { searchVolume: 390, cpc: 8.44, competition: "MEDIUM" },
    h1: "What should you check before sending a mutual NDA template?",
    intro: "Before sending a mutual NDA template, check who the parties are, what confidential information is covered, how long obligations last, what exclusions apply, and who is authorized to sign.",
    sections: [
      {
        heading: "A mutual NDA protects both sides",
        paragraphs: [
          "A mutual NDA is usually used when both parties expect to share confidential information. That makes the send step more sensitive than a simple intake form.",
          "An agent can help move the packet, but a person should still confirm the business context and the approved template before the recipient receives it."
        ]
      },
      {
        heading: "Run a pre-send checklist",
        paragraphs: [
          "The checklist should be short enough to actually use. The sender should confirm the parties, purpose, term, exclusions, governing law, signer authority, and any deal-specific fields before approving the dry run.",
          "If any of those fields are uncertain, the agent should stop and ask for review instead of guessing."
        ],
        bullets: [
          "Are both parties correctly named?",
          "Is the purpose accurate?",
          "Are standard exclusions present?",
          "Is the term acceptable?",
          "Is the signer authorized?",
          "Does the dry run match the intended send?"
        ]
      },
      {
        heading: "Send the template, then track the record",
        paragraphs: [
          "Once approved, the agent can send the mutual NDA and track status. After signature, the workflow should store the executed PDF, audit events, and hash.",
          "The value is not just faster sending. It is knowing which NDA was sent, who signed, and where the record is."
        ]
      }
    ],
    faqs: [
      {
        question: "Can an agent choose between mutual and one-way NDA templates?",
        answer: "Only if the business rule is explicit and a human approves the dry run. When in doubt, the agent should ask."
      },
      {
        question: "Is a public mutual NDA template enough?",
        answer: "No public template is a substitute for legal review. Treat templates as starting points and use approved language before sending."
      }
    ],
    sources: [
      { label: "GOV.UK NDA guidance and examples", href: "https://www.gov.uk/government/publications/non-disclosure-agreements" },
      { label: "oneNDA mutual NDA standard", href: "https://www.lawinsider.com/standards/onenda" }
    ],
    internalLinks: [
      { label: "Mutual NDA template", href: "/templates/mutual-nda" },
      { label: "One-way NDA template", href: "/templates/one-way-nda" },
      { label: "CLI", href: "/cli" }
    ]
  },
  {
    slug: "one-way-nda-template-sales-demos-contractors",
    title: "When should a one-way NDA template be used for demos or contractors? | AgentContract Blog",
    description: "A one-way NDA template is usually for situations where one side discloses confidential information, such as demos, diligence, interviews, or contractor onboarding.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "6 min read",
    keyword: "one way nda template",
    dataForSeo: { searchVolume: 20, cpc: 9.08, competition: "LOW" },
    h1: "When should a one-way NDA template be used for demos or contractors?",
    intro: "A one-way NDA template is usually used when one party discloses confidential information and the other party receives it. Common examples include sales demos, diligence, interviews, invention reviews, and contractor onboarding.",
    sections: [
      {
        heading: "Match the NDA shape to the information flow",
        paragraphs: [
          "If both sides are sharing confidential information, a mutual NDA may be the better shape. If one side is primarily disclosing, a one-way NDA may fit the workflow.",
          "That choice should be made by a person or an explicit business rule, not by an agent improvising from the recipient name."
        ]
      },
      {
        heading: "Use agents for the repeatable send",
        paragraphs: [
          "Once the approved one-way NDA template is selected, the agent can handle the mechanical work: fill recipient variables, run a dry run, wait for approval, send the signing link, and track completion.",
          "That keeps the agent useful without asking it to decide legal posture."
        ],
        bullets: [
          "Sales demo recipient.",
          "Contractor candidate.",
          "Vendor diligence contact.",
          "Invention review participant.",
          "Partner evaluation contact."
        ]
      },
      {
        heading: "Keep the signed NDA tied to the opportunity",
        paragraphs: [
          "The signed record should link back to the opportunity, candidate, vendor, or project that required it. Metadata makes that possible.",
          "When the NDA is signed, the workflow can continue with a verifiable record instead of a vague note that legal paperwork was probably done."
        ]
      }
    ],
    faqs: [
      {
        question: "Can the same one-way NDA template be used everywhere?",
        answer: "No. Use approved templates for the right context and jurisdiction. AgentContract helps with sending and tracking, not legal review."
      },
      {
        question: "What should happen before a one-way NDA is sent?",
        answer: "The agent should show a dry run and wait for explicit human approval."
      }
    ],
    sources: [
      { label: "Stanford one-way NDA sample", href: "https://nonprofitdocuments.law.stanford.edu/non-disclosure/non-disclosure-agreement-one-way/" },
      { label: "GOV.UK NDA guidance and examples", href: "https://www.gov.uk/government/publications/non-disclosure-agreements" }
    ],
    internalLinks: [
      { label: "One-way NDA template", href: "/templates/one-way-nda" },
      { label: "Mutual NDA template", href: "/templates/mutual-nda" },
      { label: "Contract sending API", href: "/contract-sending-api" }
    ]
  },
  {
    slug: "privacy-policy-template-for-marketplace-onboarding",
    title: "How should marketplaces use a privacy policy template? | AgentContract Blog",
    description: "Marketplaces can use a privacy policy template or privacy acknowledgement as an approved onboarding packet, but it should be reviewed and signed deliberately.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "7 min read",
    keyword: "privacy policy template",
    dataForSeo: { searchVolume: 1600, cpc: 10.31, competition: "LOW" },
    h1: "How should marketplaces use a privacy policy template?",
    intro: "A privacy policy template should become an approved onboarding packet only after review. For marketplaces, the practical workflow is to show contributors what data terms apply, collect acknowledgement or signature, and store the record.",
    sections: [
      {
        heading: "Privacy templates need more context than generic forms",
        paragraphs: [
          "Privacy language depends on the data collected, the users involved, applicable laws, vendors, retention, transfers, and rights processes. A generic privacy policy template is not enough by itself.",
          "The agent's job should not be to create privacy language. It should send the approved privacy acknowledgement or policy packet after the team has reviewed it."
        ]
      },
      {
        heading: "Use the packet as an onboarding gate",
        paragraphs: [
          "A marketplace can require contributors or vendors to acknowledge privacy terms before accessing the next workflow step. The signed or acknowledged record then becomes part of the contributor profile.",
          "That record should include the packet version, recipient, timestamp, signer consent, and hash. If the privacy language changes, the version matters."
        ],
        bullets: [
          "Policy or acknowledgement version.",
          "Contributor or vendor id.",
          "Recipient email.",
          "Completion timestamp.",
          "Signed PDF hash.",
          "Webhook event."
        ]
      },
      {
        heading: "Make updates operational",
        paragraphs: [
          "Privacy packets are not one-and-done forever. When policy language changes, your system should know which participants signed which version.",
          "AgentContract's value is in the operational layer: send the approved packet, collect the human action, and preserve the record for later."
        ]
      }
    ],
    faqs: [
      {
        question: "Is a privacy policy template legal advice?",
        answer: "No. Review privacy language with appropriate counsel. AgentContract helps send approved packets and track signed records."
      },
      {
        question: "Why does versioning matter?",
        answer: "Versioning shows which privacy terms a recipient saw and accepted at a specific time."
      }
    ],
    sources: [
      { label: "FTC consumer privacy guidance", href: "https://www.ftc.gov/business-guidance/privacy-security/consumer-privacy" },
      { label: "California DOJ CCPA overview", href: "https://www.oag.ca.gov/privacy/ccpa" },
      { label: "ICO privacy notice guidance", href: "https://ico.org.uk/for-organisations/advice-for-small-organisations/privacy-notices-and-cookies/how-to-write-a-privacy-notice-and-what-goes-in-it/" }
    ],
    internalLinks: [
      { label: "Privacy policy template", href: "/templates/privacy-policy" },
      { label: "Marketplace onboarding post", href: "/blog/marketplace-onboarding-contract-workflow" },
      { label: "Docs", href: "/docs" }
    ]
  },
  {
    slug: "ai-agent-contracts-operating-model",
    title: "What are AI agent contracts, and who signs them? | AgentContract Blog",
    description: "AI agent contracts are approved agreement workflows that agents can prepare and send while humans stay responsible for review, consent, and signature.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "6 min read",
    keyword: "ai agent contracts",
    h1: "What are AI agent contracts, and who signs them?",
    intro: "AI agent contracts are not contracts signed by models. A safer definition is approved contract workflows that agents can prepare and send, while humans review and sign.",
    sections: [
      {
        heading: "Separate the sender from the signer",
        paragraphs: [
          "An AI agent can be the operational sender. It can collect known variables, choose an approved template under a rule, run a dry run, and send the packet after approval.",
          "The signer is still a person. The signer reviews the agreement, consents to electronic signature, and submits the signed record. That separation is the whole point."
        ]
      },
      {
        heading: "Give agents a narrow contract tool",
        paragraphs: [
          "The agent should not have an open-ended legal drafting tool inside the send path. It should have commands that map to safe operations: list templates, read template, dry-run send, send approved packet, read status, remind, cancel, and download PDF.",
          "Narrow commands make the workflow easier to audit and easier for the human operator to trust."
        ],
        bullets: [
          "Agent prepares.",
          "Human approves the send.",
          "Recipient signs.",
          "System stores the executed record.",
          "Agent reports completion."
        ]
      },
      {
        heading: "Use records instead of summaries",
        paragraphs: [
          "A model summary is not enough for a contract workflow. The system needs a signed PDF, audit log, timestamps, signer fields, and a hash.",
          "Those records let a product or marketplace continue after signature without relying on a conversational transcript as the source of truth."
        ]
      }
    ],
    faqs: [
      {
        question: "Can an AI agent be a party to a contract?",
        answer: "AgentContract does not try to make agents contract parties or signers. It supports agent-assisted sending of approved packets for human signature."
      },
      {
        question: "What is the safest first AI agent contract workflow?",
        answer: "Start with a low-variance approved packet such as an NDA, privacy acknowledgement, or contractor agreement."
      }
    ],
    internalLinks: [
      { label: "AI agent contracts page", href: "/ai-agent-contracts" },
      { label: "E-signature for AI agents", href: "/esignature-for-ai-agents" },
      { label: "CLI playbook", href: "/blog/agent-contract-cli-playbook" }
    ]
  },
  {
    slug: "human-in-the-loop-ai-contract-signing",
    title: "Why is contract signing a human-in-the-loop AI workflow? | AgentContract Blog",
    description: "Contract signing is a clean human-in-the-loop AI workflow because agents can handle repeatable operations while people retain approval and signature authority.",
    published: "June 5, 2026",
    publishedIso: "2026-06-05",
    readTime: "6 min read",
    keyword: "human in the loop ai",
    dataForSeo: { searchVolume: 1000, cpc: 11.93, competition: "LOW" },
    h1: "Why is contract signing a human-in-the-loop AI workflow?",
    intro: "Contract signing is a natural human-in-the-loop AI workflow because the agent can handle repeatable operations, while people retain the approval, review, consent, and signature steps.",
    sections: [
      {
        heading: "The loop is explicit",
        paragraphs: [
          "A good human-in-the-loop workflow has a clear pause where the person reviews what the agent is about to do. Contract sending should have that pause in the dry run.",
          "The agent prepares the packet. The human approves the send. The recipient signs. The system records completion. Each step has an owner."
        ]
      },
      {
        heading: "The agent handles speed, the human handles authority",
        paragraphs: [
          "Agents are useful because they can repeat operational steps quickly. They can fill known variables, send approved packets, check status, send reminders, and retrieve signed records.",
          "Humans remain responsible for authority. They decide whether a packet should be sent, whether the recipient is right, and whether the signing action is theirs to take."
        ],
        bullets: [
          "Agent: prepare, dry-run, send, track.",
          "Operator: approve the real send.",
          "Signer: review and sign.",
          "System: preserve audit events and signed records."
        ]
      },
      {
        heading: "This pattern makes AI adoption less scary",
        paragraphs: [
          "Teams do not need to decide whether agents can do everything. They can start with one bounded workflow where the agent's responsibilities are visible and the human gates are real.",
          "That is why contract signing is a useful test case for human-in-the-loop AI. It is practical, repetitive, and high enough stakes that the boundary has to be honest."
        ]
      }
    ],
    faqs: [
      {
        question: "What is the human loop in contract signing?",
        answer: "The loop is the dry-run approval before send and the human signature at completion."
      },
      {
        question: "Can this pattern apply outside contracts?",
        answer: "Yes. Any high-consequence agent workflow benefits from explicit preview, approval, action, and audit phases."
      }
    ],
    internalLinks: [
      { label: "E-signature for AI agents", href: "/esignature-for-ai-agents" },
      { label: "AI agent contracts", href: "/ai-agent-contracts" },
      { label: "Docs", href: "/docs" }
    ]
  }
];

const allBlogPosts = [...blogPosts, ...dataForSeoBlogPosts];

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeXml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function canonicalOrigin(origin: string) {
  try {
    const hostname = new URL(origin).hostname;
    if (hostname === "agentink-pied.vercel.app" || hostname.endsWith(".vercel.app")) return "https://agentcontract.to";
  } catch {
    return origin;
  }
  return origin;
}

function canonicalUrl(origin: string, path = "/") {
  return `${canonicalOrigin(origin)}${path.startsWith("/") ? path : `/${path}`}`;
}

function publicUrl(path = "/") {
  return canonicalUrl(primaryOrigin, path);
}

function jsonLd(value: unknown) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function structuredData(origin: string) {
  const homeUrl = canonicalUrl(origin);
  const organizationId = `${homeUrl}#organization`;

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organizationId,
        name: "AgentContract",
        url: homeUrl,
        description: pageDescription
      },
      {
        "@type": "WebSite",
        "@id": `${homeUrl}#website`,
        name: "AgentContract",
        url: homeUrl,
        description: pageDescription,
        inLanguage: "en-US",
        publisher: { "@id": organizationId }
      },
      {
        "@type": "Service",
        "@id": `${homeUrl}#service`,
        name: "AgentContract",
        serviceType: "Contract signing API and CLI for AI agents",
        url: homeUrl,
        description: pageDescription,
        provider: { "@id": organizationId },
        audience: {
          "@type": "Audience",
          audienceType: "AI agent builders, marketplace operators, compliance teams"
        }
      }
    ]
  };
}

function robotsTxt(_origin: string) {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /dashboard/",
    "Disallow: /auth/",
    "Disallow: /cli/login",
    "Disallow: /cli/magic/",
    "Disallow: /sign/",
    "Disallow: /v1/",
    `Sitemap: ${publicUrl("/sitemap.xml")}`,
    ""
  ].join("\n");
}

function sitemapXml(_origin: string) {
  const urls = [
    { loc: publicUrl(), priority: "1.0", changefreq: "weekly" },
    { loc: publicUrl("/docs"), priority: "0.9", changefreq: "weekly" },
    { loc: publicUrl("/docs.md"), priority: "0.85", changefreq: "weekly" },
    { loc: publicUrl("/cli"), priority: "0.8", changefreq: "monthly" },
    ...publicSeoPages.map((page) => ({ loc: publicUrl(page.path), priority: "0.75", changefreq: "monthly" })),
    { loc: publicUrl("/blog"), priority: "0.72", changefreq: "weekly" },
    ...allBlogPosts.map((post) => ({ loc: publicUrl(`/blog/${post.slug}`), priority: "0.68", changefreq: "monthly" })),
    { loc: publicUrl("/templates"), priority: "0.7", changefreq: "monthly" },
    ...publicTemplateIds.map((id) => ({ loc: publicUrl(`/templates/${id}`), priority: "0.6", changefreq: "monthly" }))
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url>
    <loc>${escapeXml(url.loc)}</loc>
    <changefreq>${url.changefreq}</changefreq>
    <priority>${url.priority}</priority>
  </url>`).join("\n")}
</urlset>
`;
}

function llmsTxt(_origin: string) {
  return `# AgentContract

> Contract signing API and CLI for AI agents.

AgentContract lets AI agent workflows send approved NDAs, privacy acknowledgements, and contractor agreements. Agents send approved packets only; humans sign contracts in the browser. The system returns signed PDFs, SHA-256 hashes, webhooks, status, and audit trails.

## Primary Links

- [Homepage](${publicUrl()}): Product overview for agent-sent, human-signed contracts.
- [Docs](${publicUrl("/docs")}): Complete AgentContract docs for CLI, API, templates, webhooks, deployment, and troubleshooting.
- [Agent-readable docs](${publicUrl("/docs.md")}): Plain Markdown docs for AI agents, crawlers, and retrieval systems.
- [AI agent contracts](${publicUrl("/ai-agent-contracts")}): Search-focused overview of controlled contracts for AI agents.
- [Contract sending API](${publicUrl("/contract-sending-api")}): API page for sending approved contracts from agent workflows.
- [Agent contract CLI](${publicUrl("/agent-contract-cli")}): CLI overview for local AI coding agents and scripts.
- [E-signature for AI agents](${publicUrl("/esignature-for-ai-agents")}): Human-in-the-loop e-signature workflow page.
- [CLI docs](${publicUrl("/cli")}): Install, authenticate, inspect templates, send agreements, track status, and report failures.
- [Template library](${publicUrl("/templates")}): Public previews for standard mutual NDA, one-way NDA, and website/app privacy policy templates.
- [CLI installer](${publicUrl("/cli/install.sh")}): Shell installer for Node.js 20+ environments.
- [Status and version metadata](${publicUrl("/healthz")}): Current AgentContract service and CLI version metadata.

## Agent Guidance

- Use AgentContract for sending approved contract templates from agent workflows.
- Do not use AgentContract to let agents draft legal terms or sign contracts.
- Run \`agentcontract skill\` after installing the CLI to print agent integration instructions.
- Prefer preview, dry-run, and template read commands before sending email to signers.

## Useful Concepts

- Approved template API
- Recipient browser signing
- Signed PDF storage
- SHA-256 PDF hashes
- Webhook completion events
- Audit events for contract status changes
`;
}

function publicTemplateKind(id: PublicTemplateId) {
  if (id === "privacy-policy") return "Privacy policy";
  if (id === "one-way-nda") return "One-way NDA";
  return "Mutual NDA";
}

function publicTemplateResearch(id: PublicTemplateId) {
  if (id === "privacy-policy") {
    return [
      { label: "FTC consumer privacy guidance", href: "https://www.ftc.gov/business-guidance/privacy-security/consumer-privacy" },
      { label: "California DOJ CCPA overview", href: "https://www.oag.ca.gov/privacy/ccpa" },
      { label: "ICO privacy notice guidance", href: "https://ico.org.uk/for-organisations/advice-for-small-organisations/privacy-notices-and-cookies/how-to-write-a-privacy-notice-and-what-goes-in-it/" }
    ];
  }
  return [
    { label: "GOV.UK NDA guidance and examples", href: "https://www.gov.uk/government/publications/non-disclosure-agreements" },
    { label: "oneNDA mutual NDA standard", href: "https://www.lawinsider.com/standards/onenda" },
    { label: "Stanford one-way NDA sample", href: "https://nonprofitdocuments.law.stanford.edu/non-disclosure/non-disclosure-agreement-one-way/" }
  ];
}

function publicTemplateCss() {
  return `
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --paper: #ffffff;
      --ink: #080b12;
      --text: #1b2433;
      --muted: #697386;
      --quiet: #929aab;
      --line: #d9dfeb;
      --line-dark: #aeb7c8;
      --blue: #194fe5;
      --green: #0d7659;
      --amber: #8a5a00;
      --amber-soft: #fff7df;
      --shadow: 0 24px 70px rgba(15, 23, 42, .1);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        linear-gradient(90deg, rgba(8, 11, 18, .04) 1px, transparent 1px),
        linear-gradient(180deg, rgba(8, 11, 18, .04) 1px, transparent 1px),
        var(--bg);
      background-size: 4.5rem 4.5rem;
      color: var(--text);
      font-family: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    a { color: inherit; text-decoration: none; }
    code, pre { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
    code {
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .shell { width: min(100% - 2rem, 1120px); margin: 0 auto; }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      min-height: 4.25rem;
      border-bottom: 1px solid var(--line);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: .7rem;
      color: var(--ink);
      font-weight: 750;
    }
    .mark {
      display: grid;
      place-items: center;
      width: 2rem;
      height: 2rem;
      border: 1px solid var(--ink);
      background: var(--paper);
    }
    .nav {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: .45rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .78rem;
      font-weight: 750;
      text-transform: uppercase;
    }
    .nav a {
      border: 1px solid var(--line-dark);
      background: rgba(255,255,255,.72);
      padding: .58rem .7rem;
    }
    .nav a.primary { background: var(--ink); color: white; border-color: var(--ink); }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, .92fr) minmax(22rem, 1.08fr);
      gap: clamp(1.75rem, 4vw, 3.5rem);
      align-items: center;
      padding: clamp(2.4rem, 5vw, 4.2rem) 0 clamp(1.6rem, 3vw, 2.4rem);
    }
    .eyebrow {
      display: inline-flex;
      border: 1px solid var(--line-dark);
      background: var(--paper);
      color: var(--muted);
      padding: .4rem .55rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .74rem;
      font-weight: 750;
      text-transform: uppercase;
    }
    h1 {
      margin: 1rem 0 0;
      max-width: 12ch;
      color: var(--ink);
      font-size: clamp(2.45rem, 4.2vw, 4.1rem);
      line-height: 1.06;
      font-weight: 650;
      letter-spacing: 0;
    }
    .hero p {
      margin: 1rem 0 0;
      color: var(--muted);
      font-size: 1.05rem;
      line-height: 1.62;
      max-width: 44rem;
    }
    .notice {
      border: 1px solid var(--line-dark);
      background: var(--amber-soft);
      padding: 1rem;
      color: #4a3300;
      line-height: 1.55;
      max-width: 40rem;
    }
    .template-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1rem;
      margin: 0 auto clamp(2.4rem, 5vw, 4rem);
    }
    .template-card {
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      gap: .85rem;
      border: 1px solid var(--line-dark);
      background: var(--paper);
      min-height: 14.5rem;
      padding: 1.15rem;
      box-shadow: 0 12px 40px rgba(15, 23, 42, .06);
    }
    .template-card h2,
    .content h2 {
      margin: 0;
      color: var(--ink);
      font-size: 1.15rem;
      line-height: 1.25;
    }
    .template-card p {
      margin: 0;
      color: var(--muted);
      line-height: 1.55;
      font-size: .94rem;
    }
    .tag {
      display: inline-flex;
      width: fit-content;
      border: 1px solid var(--line);
      background: #eef3ff;
      color: var(--blue);
      padding: .25rem .42rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .72rem;
      font-weight: 750;
      text-transform: uppercase;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.55rem;
      border: 1px solid var(--ink);
      background: var(--ink);
      color: white;
      padding: .64rem .85rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .78rem;
      font-weight: 750;
      text-transform: uppercase;
      width: fit-content;
      align-self: end;
    }
    .detail {
      display: grid;
      grid-template-columns: minmax(18rem, 24rem) minmax(0, 1fr);
      gap: 1.25rem;
      align-items: start;
      padding-bottom: 3rem;
    }
    .panel,
    .content {
      border: 1px solid var(--line-dark);
      background: var(--paper);
      box-shadow: var(--shadow);
    }
    .panel { padding: 1rem; }
    .panel h2 { margin: 0 0 .7rem; color: var(--ink); font-size: 1rem; }
    .panel ul { margin: 0; padding: 0; list-style: none; display: grid; gap: .55rem; }
    .panel li { color: var(--muted); font-size: .9rem; line-height: 1.4; }
    .panel b { color: var(--ink); }
    .panel a { color: var(--blue); font-weight: 700; }
    .command {
      margin-top: 1rem;
      background: #0c111d;
      color: #f8fafc;
      padding: .9rem;
      overflow-x: auto;
      font-size: .78rem;
      line-height: 1.6;
      white-space: pre-wrap;
    }
    .content {
      padding: clamp(1.1rem, 3vw, 2rem);
      overflow: hidden;
    }
    .document {
      max-width: 48rem;
      color: #1e293b;
    }
    .document h1 {
      margin: 0 0 1rem;
      font-size: clamp(1.85rem, 3vw, 2.5rem);
      line-height: 1.16;
    }
    .document h2 {
      margin-top: 1.45rem;
      margin-bottom: .5rem;
    }
    .document p,
    .document li {
      line-height: 1.66;
    }
    .document ul { padding-left: 1.2rem; }
    .document hr {
      border: 0;
      border-top: 1px solid var(--line);
      margin: 1.4rem 0;
    }
    .footer {
      border-top: 1px solid var(--line);
      padding: 1.3rem 0;
      color: var(--muted);
      font-size: .9rem;
    }
    .footer a { color: var(--ink); font-weight: 700; }
    @media (max-width: 920px) {
      .hero,
      .detail,
      .template-grid {
        grid-template-columns: 1fr;
      }
      h1 { max-width: 13ch; }
      .notice { max-width: none; }
    }
    @media (max-width: 620px) {
      .shell { width: min(100% - 1rem, 1120px); }
      .topbar { align-items: flex-start; flex-direction: column; padding: .85rem 0; }
      h1 { font-size: 2.35rem; }
      .hero { padding-top: 1.65rem; }
      .template-card { min-height: auto; }
    }
  `;
}

function publicTemplateHead(title: string, description: string, canonical: string) {
  return `<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta name="robots" content="index,follow" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>${publicTemplateCss()}</style>
</head>`;
}

function publicTemplateTopbar() {
  return `<header class="shell topbar">
    <a class="brand" href="/" aria-label="AgentContract home">
      <span class="mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M7 3.8h7.5L18 7.3v12.9H7V3.8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M14.2 4.1v3.4h3.4M9.8 11h4.8M9.8 14h4.2M9.8 17h3.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </span>
      AgentContract
    </a>
    <nav class="nav" aria-label="Template navigation">
      <a href="/templates">Templates</a>
      <a href="/cli">CLI</a>
      <a class="primary" href="/dashboard">Dashboard</a>
    </nav>
  </header>`;
}

function publicTemplateCard(id: PublicTemplateId) {
  const definition = templateDefinitions[id];
  return `<article class="template-card">
    <span class="tag">${escapeHtml(publicTemplateKind(id))}</span>
    <h2>${escapeHtml(definition.name)}</h2>
    <p>${escapeHtml(definition.description)}</p>
    <a class="button" href="/templates/${escapeHtml(id)}">Read Template</a>
  </article>`;
}

function renderPublicTemplatesPage(_origin: string) {
  const description = "Read public standard templates for mutual NDAs, one-way NDAs, and website/app privacy policies before sending them through AgentContract.";
  return `<!doctype html>
<html lang="en">
${publicTemplateHead("Standard Legal Templates | AgentContract", description, publicUrl("/templates"))}
<body>
  ${publicTemplateTopbar()}
  <main>
    <section class="shell hero">
      <div>
        <span class="eyebrow">Public Template Library</span>
        <h1>Standard templates people can read first.</h1>
      </div>
      <div>
        <p>These generic templates are visible without logging in and can be inspected through the CLI or API before anyone sends a signing request.</p>
        <p class="notice">Template only, not legal advice. Review with counsel before using in production, especially for regulated data, employment terms, consumers, health data, financial data, international users, or state-specific privacy rights.</p>
      </div>
    </section>

    <section class="shell template-grid" aria-label="Public templates">
      ${publicTemplateIds.map(publicTemplateCard).join("")}
    </section>
  </main>
  <footer class="footer">
    <div class="shell">AgentContract public templates: <a href="/templates/mutual-nda">Mutual NDA</a> · <a href="/templates/one-way-nda">One-way NDA</a> · <a href="/templates/privacy-policy">Privacy Policy</a></div>
  </footer>
</body>
</html>`;
}

function templateVariablesList(definition: TemplateDefinition) {
  return definition.variables.map((variable) => `<li><b>${escapeHtml(variable.key)}</b>: ${escapeHtml(variable.defaultValue)}</li>`).join("");
}

function templateResearchList(id: PublicTemplateId) {
  return publicTemplateResearch(id).map((source) => `<li><a href="${escapeHtml(source.href)}">${escapeHtml(source.label)}</a></li>`).join("");
}

function renderPublicTemplatePage(_origin: string, id: PublicTemplateId) {
  const definition = templateDefinitions[id];
  const defaults = {
    ...defaultTemplateVars(definition),
    recipient_name: "Jane Recipient",
    recipient_email: "jane@example.com"
  };
  const markdown = applyTemplateVars(loadTemplate(id), defaults);
  const documentHtml = marked.parse(markdown, { async: false }) as string;
  const command = `agentcontract template read ${id} --out ./${id}.md
agentcontract template send ${id} --to jane@example.com --name "Jane Recipient"`;
  const description = `${definition.name} public preview and template variables for AgentContract.`;

  return `<!doctype html>
<html lang="en">
${publicTemplateHead(`${definition.name} | AgentContract Templates`, description, publicUrl(`/templates/${id}`))}
<body>
  ${publicTemplateTopbar()}
  <main>
    <section class="shell hero">
      <div>
        <span class="eyebrow">${escapeHtml(publicTemplateKind(id))}</span>
        <h1>${escapeHtml(definition.name)}</h1>
      </div>
      <div>
        <p>${escapeHtml(definition.description)}</p>
        <p class="notice">Template only, not legal advice. The preview uses sample values. Replace variables, confirm governing law, and review with counsel before sending.</p>
      </div>
    </section>

    <section class="shell detail">
      <aside class="panel">
        <h2>Variables</h2>
        <ul>${templateVariablesList(definition)}</ul>
        <h2 style="margin-top:1.2rem;">Research Basis</h2>
        <ul>${templateResearchList(id)}</ul>
        <pre class="command"><code>${escapeHtml(command)}</code></pre>
      </aside>
      <section class="content">
        <article class="document">${documentHtml}</article>
      </section>
    </section>
  </main>
  <footer class="footer">
    <div class="shell"><a href="/templates">All templates</a> · <a href="/cli">CLI docs</a> · <a href="/dashboard">Dashboard</a></div>
  </footer>
</body>
</html>`;
}

function seoPageCss() {
  return `
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --paper: #ffffff;
      --ink: #080b12;
      --text: #1b2433;
      --muted: #667085;
      --line: #d9dfeb;
      --blue: #194fe5;
      --green: #0d7659;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        linear-gradient(90deg, rgba(8, 11, 18, .045) 1px, transparent 1px),
        linear-gradient(180deg, rgba(8, 11, 18, .045) 1px, transparent 1px),
        var(--bg);
      background-size: 4.6rem 4.6rem;
      color: var(--text);
      font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0;
    }
    a { color: inherit; text-decoration: none; }
    .shell {
      width: min(100% - 2rem, 1120px);
      margin: 0 auto;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      min-height: 4.5rem;
      border-bottom: 1px solid var(--line);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: .7rem;
      color: var(--ink);
      font-weight: 700;
    }
    .mark {
      display: grid;
      place-items: center;
      width: 2.05rem;
      height: 2.05rem;
      border: 1px solid var(--ink);
      background: var(--paper);
    }
    .nav {
      display: flex;
      align-items: center;
      gap: .35rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .82rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .nav a {
      border: 1px solid transparent;
      padding: .62rem .75rem;
    }
    .nav .primary {
      border-color: var(--ink);
      background: var(--ink);
      color: white;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, .92fr) minmax(24rem, 1.08fr);
      gap: clamp(2rem, 5vw, 4.8rem);
      align-items: start;
      padding: clamp(3rem, 7vw, 5.2rem) 0 clamp(2.2rem, 5vw, 4rem);
    }
    .eyebrow {
      display: inline-flex;
      border: 1px solid var(--line);
      background: var(--paper);
      color: var(--muted);
      padding: .42rem .55rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .76rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    h1 {
      margin: 1rem 0 0;
      max-width: 13ch;
      color: var(--ink);
      font-size: clamp(2.65rem, 5.1vw, 5rem);
      line-height: 1;
      font-weight: 600;
      letter-spacing: 0;
    }
    .lede {
      margin: 1.25rem 0 0;
      color: var(--muted);
      font-size: 1.08rem;
      line-height: 1.68;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: .7rem;
      margin-top: 1.4rem;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.85rem;
      border: 1px solid var(--ink);
      padding: .72rem 1rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .82rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .button.primary {
      background: var(--ink);
      color: white;
    }
    .button.secondary {
      background: var(--paper);
      color: var(--ink);
    }
    .preview {
      border: 1px solid var(--ink);
      background: var(--paper);
      box-shadow: 0 30px 90px rgba(15, 23, 42, .12);
      padding: 1rem;
    }
    .preview header {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      border-bottom: 1px solid var(--line);
      padding-bottom: .85rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .76rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .preview h2 {
      margin: 1rem 0 .55rem;
      color: var(--ink);
      font-size: 1.15rem;
      line-height: 1.25;
    }
    .line {
      height: .55rem;
      border-radius: 999px;
      background: #dfe5ef;
      margin-top: .62rem;
    }
    .line:nth-child(4) { width: 88%; }
    .line:nth-child(5) { width: 72%; }
    .line:nth-child(6) { width: 94%; }
    .proof {
      border-left: 3px solid var(--green);
      margin-top: 1rem;
      background: #edf8f3;
      color: #184e3d;
      padding: .85rem;
      line-height: 1.5;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1px;
      border: 1px solid var(--ink);
      background: var(--ink);
      margin-bottom: clamp(3rem, 7vw, 5rem);
    }
    .card {
      background: var(--paper);
      padding: 1.1rem;
      min-height: 12rem;
    }
    .card h2 {
      margin: 0;
      color: var(--ink);
      font-size: 1.05rem;
      line-height: 1.25;
    }
    .card p {
      margin: .65rem 0 0;
      color: var(--muted);
      font-size: .94rem;
      line-height: 1.58;
    }
    .footer {
      border-top: 1px solid var(--line);
      background: var(--paper);
      color: var(--muted);
      padding: 1.3rem 0;
      font-size: .9rem;
    }
    .footer a { color: var(--ink); font-weight: 700; }
    @media (max-width: 900px) {
      .hero,
      .grid {
        grid-template-columns: 1fr;
      }
      .nav { flex-wrap: wrap; justify-content: flex-end; }
    }
    @media (max-width: 620px) {
      .shell { width: min(100% - 1rem, 1120px); }
      .topbar { align-items: flex-start; flex-direction: column; padding: .85rem 0; }
      h1 { font-size: 2.55rem; }
      .actions .button { width: 100%; }
    }
  `;
}

function seoTopbar() {
  return `<header class="shell topbar">
    <a class="brand" href="/" aria-label="AgentContract home">
      <span class="mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M7 3.8h7.5L18 7.3v12.9H7V3.8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M14.2 4.1v3.4h3.4M9.8 11h4.8M9.8 14h4.2M9.8 17h3.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </span>
      AgentContract
    </a>
    <nav class="nav" aria-label="SEO page navigation">
      <a href="/ai-agent-contracts">AI Contracts</a>
      <a href="/contract-sending-api">API</a>
      <a href="/agent-contract-cli">CLI</a>
      <a href="/esignature-for-ai-agents">E-sign</a>
      <a class="primary" href="/docs">Docs</a>
    </nav>
  </header>`;
}

function renderSeoPage(page: PublicSeoPage) {
  const canonical = publicUrl(page.path);
  const sectionCards = page.sections.map((section) => `<article class="card">
      <h2>${escapeHtml(section.heading)}</h2>
      <p>${escapeHtml(section.body)}</p>
    </article>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(page.title)}</title>
  <meta name="description" content="${escapeHtml(page.description)}" />
  <meta name="robots" content="index,follow,max-image-preview:large" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${escapeHtml(canonical)}" />
  <meta property="og:site_name" content="AgentContract" />
  <meta property="og:title" content="${escapeHtml(page.title)}" />
  <meta property="og:description" content="${escapeHtml(page.description)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${escapeHtml(page.title)}" />
  <meta name="twitter:description" content="${escapeHtml(page.description)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>${seoPageCss()}</style>
</head>
<body>
  ${seoTopbar()}
  <main>
    <section class="shell hero">
      <div>
        <span class="eyebrow">${escapeHtml(page.eyebrow)}</span>
        <h1>${escapeHtml(page.h1)}</h1>
        <p class="lede">${escapeHtml(page.intro)}</p>
        <div class="actions">
          <a class="button primary" href="/cli">Start with CLI</a>
          <a class="button secondary" href="/templates">Read templates</a>
        </div>
      </div>
      <aside class="preview" aria-label="AgentContract workflow preview">
        <header><span>Approved packet</span><span>Human signed</span></header>
        <h2>Agent-sent agreement</h2>
        <div class="line"></div>
        <div class="line"></div>
        <div class="line"></div>
        <p class="proof">${escapeHtml(page.proof)}</p>
      </aside>
    </section>
    <section class="shell grid" aria-label="AgentContract details">
      ${sectionCards}
    </section>
  </main>
  <footer class="footer">
    <div class="shell">
      Related: <a href="/ai-agent-contracts">AI agent contracts</a> · <a href="/contract-sending-api">Contract sending API</a> · <a href="/agent-contract-cli">Agent contract CLI</a> · <a href="/esignature-for-ai-agents">E-signature for AI agents</a>
    </div>
  </footer>
</body>
</html>`;
}

function blogCss() {
  return `
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --paper: #ffffff;
      --ink: #080b12;
      --text: #1d2736;
      --muted: #687386;
      --line: #dbe2ee;
      --line-dark: #aeb7c8;
      --blue: #194fe5;
      --green: #0d7659;
      --green-soft: #edf8f3;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0;
    }
    a { color: inherit; text-decoration: none; }
    .shell {
      width: min(100% - 2rem, 1120px);
      margin: 0 auto;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      min-height: 4.5rem;
      border-bottom: 1px solid var(--line);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: .7rem;
      color: var(--ink);
      font-weight: 700;
    }
    .mark {
      display: grid;
      place-items: center;
      width: 2.05rem;
      height: 2.05rem;
      border: 1px solid var(--ink);
      background: var(--paper);
    }
    .nav {
      display: flex;
      align-items: center;
      gap: .35rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .82rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .nav a {
      border: 1px solid transparent;
      padding: .62rem .75rem;
    }
    .nav .primary {
      border-color: var(--ink);
      background: var(--ink);
      color: white;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.08fr) minmax(18rem, .72fr);
      gap: clamp(2rem, 5vw, 4rem);
      padding: clamp(3rem, 8vw, 6rem) 0 clamp(2rem, 5vw, 4rem);
      align-items: end;
    }
    .kicker {
      display: inline-flex;
      border: 1px solid var(--line);
      background: var(--paper);
      color: var(--muted);
      padding: .42rem .55rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .76rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    h1 {
      margin: 1rem 0 0;
      color: var(--ink);
      font-size: clamp(2.65rem, 5vw, 4.9rem);
      line-height: 1.02;
      font-weight: 600;
      letter-spacing: 0;
    }
    .lede {
      margin: 1.2rem 0 0;
      max-width: 42rem;
      color: var(--muted);
      font-size: 1.08rem;
      line-height: 1.68;
    }
    .note {
      border: 1px solid var(--line-dark);
      background: var(--paper);
      padding: 1.15rem;
      box-shadow: 0 24px 70px rgba(15, 23, 42, .08);
    }
    .note b {
      display: block;
      color: var(--ink);
      font-size: 1.05rem;
    }
    .note p {
      margin: .65rem 0 0;
      color: var(--muted);
      line-height: 1.6;
    }
    .post-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1px;
      border: 1px solid var(--ink);
      background: var(--ink);
      margin-bottom: clamp(3rem, 7vw, 5rem);
    }
    .post-card {
      display: flex;
      flex-direction: column;
      background: var(--paper);
      min-height: 21rem;
      padding: 1.2rem;
    }
    .meta {
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .74rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .post-card h2 {
      margin: 1rem 0 .7rem;
      color: var(--ink);
      font-size: 1.35rem;
      line-height: 1.18;
    }
    .post-card p {
      margin: 0;
      color: var(--muted);
      line-height: 1.62;
    }
    .post-card a {
      display: inline-flex;
      width: fit-content;
      margin-top: auto;
      border-bottom: 1px solid var(--ink);
      color: var(--ink);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .78rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .article-shell {
      width: min(100% - 2rem, 780px);
      margin: 0 auto;
    }
    .article-head {
      padding: clamp(3rem, 8vw, 6rem) 0 2rem;
      border-bottom: 1px solid var(--line);
    }
    .article-meta {
      display: flex;
      flex-wrap: wrap;
      gap: .65rem 1rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .78rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .article-head h1 {
      max-width: none;
      font-size: clamp(2.55rem, 5vw, 4.4rem);
    }
    .article-body {
      padding: 1.4rem 0 clamp(3rem, 7vw, 5rem);
    }
    .article-body section {
      padding: 1.35rem 0;
      border-bottom: 1px solid var(--line);
    }
    .article-body section:last-child { border-bottom: 0; }
    .article-body h2 {
      margin: 0 0 .75rem;
      color: var(--ink);
      font-size: 1.55rem;
      line-height: 1.2;
      font-weight: 650;
    }
    .article-body p {
      margin: .8rem 0 0;
      color: var(--text);
      font-size: 1.03rem;
      line-height: 1.78;
    }
    .article-list {
      margin: 1rem 0 0;
      padding-left: 1.1rem;
      color: var(--text);
    }
    .article-list li {
      margin: .45rem 0;
      line-height: 1.65;
    }
    .article-panel {
      border: 1px solid var(--line-dark);
      background: var(--paper);
      padding: 1rem;
      margin-top: 1.2rem;
    }
    .article-panel h2 {
      font-size: 1.1rem;
      margin-bottom: .45rem;
    }
    .article-panel p {
      color: var(--muted);
      font-size: .96rem;
    }
    .article-panel a {
      color: var(--ink);
      font-weight: 700;
      border-bottom: 1px solid var(--ink);
    }
    .article-panel ul {
      margin: .7rem 0 0;
      padding-left: 1.1rem;
    }
    .article-panel li {
      margin: .45rem 0;
      color: var(--muted);
      line-height: 1.55;
    }
    .faq-item {
      border-top: 1px solid var(--line);
      padding-top: .85rem;
      margin-top: .85rem;
    }
    .faq-item:first-of-type {
      border-top: 0;
      padding-top: 0;
      margin-top: 0;
    }
    .faq-item h3 {
      margin: 0;
      color: var(--ink);
      font-size: 1rem;
      line-height: 1.3;
    }
    .keyword-note {
      display: inline-flex;
      flex-wrap: wrap;
      gap: .35rem;
      margin-top: 1rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .76rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .keyword-note span {
      border: 1px solid var(--line);
      background: var(--paper);
      padding: .32rem .44rem;
    }
    .article-cta {
      border: 1px solid var(--ink);
      background: var(--green-soft);
      padding: 1.1rem;
      margin-top: 1.6rem;
    }
    .article-cta p {
      margin: 0;
      color: #174b3c;
    }
    .article-cta a {
      color: var(--ink);
      font-weight: 700;
      border-bottom: 1px solid var(--ink);
    }
    .footer {
      border-top: 1px solid var(--line);
      background: var(--paper);
      color: var(--muted);
      padding: 1.3rem 0;
      font-size: .9rem;
    }
    .footer a { color: var(--ink); font-weight: 700; }
    @media (max-width: 900px) {
      .hero,
      .post-grid {
        grid-template-columns: 1fr;
      }
      .post-card { min-height: auto; gap: 1rem; }
      .nav { flex-wrap: wrap; justify-content: flex-end; }
    }
    @media (max-width: 620px) {
      .shell,
      .article-shell { width: min(100% - 1rem, 1120px); }
      .topbar { align-items: flex-start; flex-direction: column; padding: .85rem 0; }
      h1,
      .article-head h1 { font-size: 2.45rem; }
      .hero,
      .article-head { padding-top: 2rem; }
    }
  `;
}

function blogHead(title: string, description: string, canonical: string) {
  return `<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta name="robots" content="index,follow,max-image-preview:large" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${escapeHtml(canonical)}" />
  <meta property="og:site_name" content="AgentContract" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>${blogCss()}</style>
</head>`;
}

function blogTopbar() {
  return `<header class="shell topbar">
    <a class="brand" href="/" aria-label="AgentContract home">
      <span class="mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M7 3.8h7.5L18 7.3v12.9H7V3.8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M14.2 4.1v3.4h3.4M9.8 11h4.8M9.8 14h4.2M9.8 17h3.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </span>
      AgentContract
    </a>
    <nav class="nav" aria-label="Blog navigation">
      <a href="/blog">Blog</a>
      <a href="/cli">CLI</a>
      <a href="/templates">Templates</a>
      <a class="primary" href="/docs">Docs</a>
    </nav>
  </header>`;
}

function renderBlogIndex(_origin: string) {
  const title = "AgentContract Blog | AI agent contract workflows";
  const description = "Field notes on AI agent contract workflows, human e-signature boundaries, contract sending APIs, and AgentContract CLI playbooks.";
  const postCards = allBlogPosts.map((post) => `<article class="post-card">
      <div class="meta">${escapeHtml(post.published)} · ${escapeHtml(post.readTime)}</div>
      <h2>${escapeHtml(post.h1)}</h2>
      <p>${escapeHtml(post.description)}</p>
      <a href="/blog/${escapeHtml(post.slug)}">Read post</a>
    </article>`).join("");

  return `<!doctype html>
<html lang="en">
${blogHead(title, description, publicUrl("/blog"))}
<body>
  ${blogTopbar()}
  <main>
    <section class="shell hero">
      <div>
        <span class="kicker">AgentContract Blog</span>
        <h1>Field notes for agent-sent paperwork.</h1>
        <p class="lede">Practical writing on contract workflows where agents can prepare and send approved packets, while people stay responsible for review and signature.</p>
      </div>
      <aside class="note">
        <b>Why write this now?</b>
        <p>AgentContract already has real recipient signing activity. These posts are aimed at turning that operational proof into sender and agent adoption.</p>
      </aside>
    </section>

    <section class="shell post-grid" aria-label="AgentContract blog posts">
      ${postCards}
    </section>
  </main>
  <footer class="footer">
    <div class="shell">AgentContract Blog · <a href="/cli">CLI</a> · <a href="/docs">Docs</a> · <a href="/templates">Templates</a></div>
  </footer>
</body>
</html>`;
}

function articleLink(link: { label: string; href: string }) {
  const externalAttrs = /^https?:\/\//.test(link.href) ? ' target="_blank" rel="noopener noreferrer"' : "";
  return `<a href="${escapeHtml(link.href)}"${externalAttrs}>${escapeHtml(link.label)}</a>`;
}

function renderBlogPost(_origin: string, post: BlogPost) {
  const canonical = publicUrl(`/blog/${post.slug}`);
  const sections = post.sections.map((section) => `<section>
      <h2>${escapeHtml(section.heading)}</h2>
      ${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}
      ${section.bullets ? `<ul class="article-list">${section.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>` : ""}
    </section>`).join("");
  const keywordNote = post.keyword ? `<div class="keyword-note">
          <span>Target: ${escapeHtml(post.keyword)}</span>
          ${post.dataForSeo?.searchVolume ? `<span>${escapeHtml(post.dataForSeo.searchVolume)} monthly searches</span>` : ""}
          ${post.dataForSeo?.cpc ? `<span>$${escapeHtml(post.dataForSeo.cpc)} CPC</span>` : ""}
          ${post.dataForSeo?.competition ? `<span>${escapeHtml(post.dataForSeo.competition)} competition</span>` : ""}
        </div>` : "";
  const faqPanel = post.faqs?.length ? `<aside class="article-panel" aria-label="FAQ">
          <h2>FAQ</h2>
          ${post.faqs.map((faq) => `<div class="faq-item">
            <h3>${escapeHtml(faq.question)}</h3>
            <p>${escapeHtml(faq.answer)}</p>
          </div>`).join("")}
        </aside>` : "";
  const sourcesPanel = post.sources?.length ? `<aside class="article-panel" aria-label="Research sources">
          <h2>Research sources</h2>
          <ul>${post.sources.map((source) => `<li>${articleLink(source)}</li>`).join("")}</ul>
        </aside>` : "";
  const relatedPanel = post.internalLinks?.length ? `<aside class="article-panel" aria-label="Related AgentContract pages">
          <h2>Related AgentContract pages</h2>
          <ul>${post.internalLinks.map((link) => `<li>${articleLink(link)}</li>`).join("")}</ul>
        </aside>` : "";
  const keywords = [post.keyword, ...(post.internalLinks?.map((link) => link.label) ?? [])].filter(Boolean);
  const schema = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.h1,
    description: post.description,
    url: canonical,
    mainEntityOfPage: canonical,
    datePublished: post.publishedIso ?? "2026-06-05",
    dateModified: post.publishedIso ?? "2026-06-05",
    inLanguage: "en-US",
    author: {
      "@type": "Organization",
      name: "AgentContract"
    },
    publisher: {
      "@type": "Organization",
      name: "AgentContract",
      url: publicUrl()
    },
    keywords
  };

  return `<!doctype html>
<html lang="en">
${blogHead(post.title, post.description, canonical)}
<body>
  ${blogTopbar()}
  <script type="application/ld+json">${jsonLd(schema)}</script>
  <main>
    <article class="article-shell">
      <header class="article-head">
        <div class="article-meta">
          <span>${escapeHtml(post.published)}</span>
          <span>${escapeHtml(post.readTime)}</span>
        </div>
        <h1>${escapeHtml(post.h1)}</h1>
        <p class="lede">${escapeHtml(post.intro)}</p>
        ${keywordNote}
      </header>
      <div class="article-body">
        ${sections}
        ${faqPanel}
        ${sourcesPanel}
        ${relatedPanel}
        <aside class="article-cta">
          <p>Give an agent a controlled sending path with the <a href="/cli">AgentContract CLI</a>, or inspect the <a href="/templates">public templates</a> before a send.</p>
        </aside>
      </div>
    </article>
  </main>
  <footer class="footer">
    <div class="shell"><a href="/blog">All posts</a> · <a href="/cli">CLI</a> · <a href="/docs">Docs</a></div>
  </footer>
</body>
</html>`;
}

function docsPageCss() {
  return `
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --paper: #ffffff;
      --ink: #080b12;
      --text: #1b2433;
      --muted: #647084;
      --line: #d9dfeb;
      --line-dark: #aeb7c8;
      --blue: #194fe5;
      --blue-soft: #eef3ff;
      --green: #0d7659;
      --green-soft: #e9f7f1;
      --dark: #0c111d;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    html, body {
      max-width: 100%;
      overflow-x: clip;
    }
    body {
      margin: 0;
      background:
        linear-gradient(90deg, rgba(8, 11, 18, .042) 1px, transparent 1px),
        linear-gradient(180deg, rgba(8, 11, 18, .042) 1px, transparent 1px),
        var(--bg);
      background-size: 4.6rem 4.6rem;
      color: var(--text);
      font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0;
    }
    a { color: inherit; text-decoration: none; }
    code, pre { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
    code {
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .shell {
      width: min(100% - 2rem, 1180px);
      margin: 0 auto;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      min-height: 4.5rem;
      border-bottom: 1px solid var(--line);
      background: rgba(247, 248, 251, .86);
      backdrop-filter: blur(14px);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: .7rem;
      color: var(--ink);
      font-weight: 700;
    }
    .mark {
      display: grid;
      place-items: center;
      width: 2.05rem;
      height: 2.05rem;
      border: 1px solid var(--ink);
      background: var(--paper);
    }
    .nav {
      display: flex;
      align-items: center;
      gap: .35rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .78rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .nav a {
      border: 1px solid transparent;
      padding: .58rem .68rem;
      white-space: nowrap;
    }
    .nav a:hover {
      border-color: var(--line-dark);
      background: rgba(255, 255, 255, .72);
      color: var(--ink);
    }
    .nav .primary {
      border-color: var(--ink);
      background: var(--ink);
      color: white;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, .92fr) minmax(24rem, 1.08fr);
      gap: clamp(2rem, 5vw, 4.8rem);
      align-items: start;
      padding: clamp(3rem, 7vw, 5.1rem) 0 clamp(2rem, 5vw, 3.7rem);
    }
    .eyebrow {
      display: inline-flex;
      border: 1px solid var(--line-dark);
      background: var(--paper);
      color: var(--muted);
      padding: .42rem .55rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .74rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    h1 {
      margin: 1rem 0 0;
      color: var(--ink);
      font-size: clamp(2.75rem, 4.8vw, 4.7rem);
      line-height: 1;
      font-weight: 620;
      letter-spacing: 0;
    }
    .lede {
      margin: 1.1rem 0 0;
      max-width: 40rem;
      color: var(--muted);
      font-size: 1.08rem;
      line-height: 1.64;
    }
    .hero-panel {
      border: 1px solid var(--ink);
      background: var(--paper);
      box-shadow: 0 30px 90px rgba(15, 23, 42, .12);
    }
    .hero-panel header {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      border-bottom: 1px solid var(--line-dark);
      padding: .82rem .95rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .74rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .hero-panel pre {
      margin: 0;
      padding: 1rem;
      color: #1f2937;
      font-size: .84rem;
      line-height: 1.68;
      white-space: pre-wrap;
      overflow-x: auto;
    }
    .hero-panel .code { color: #f8fafc; }
    .jump-strip {
      display: flex;
      flex-wrap: wrap;
      gap: .5rem;
      padding-bottom: clamp(2.1rem, 4vw, 3rem);
    }
    .jump-strip a {
      border: 1px solid var(--line-dark);
      background: var(--paper);
      color: var(--ink);
      padding: .62rem .76rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .78rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .section {
      border-top: 1px solid var(--line);
      padding: clamp(2.6rem, 6vw, 4.6rem) 0;
      background: rgba(255, 255, 255, .38);
    }
    .section-head {
      display: grid;
      grid-template-columns: minmax(12rem, .65fr) minmax(0, 1fr);
      gap: clamp(1.4rem, 4vw, 3rem);
      align-items: start;
      margin-bottom: 1.35rem;
    }
    h2 {
      margin: 0;
      color: var(--ink);
      font-size: clamp(1.8rem, 3.2vw, 2.75rem);
      line-height: 1.06;
      font-weight: 620;
      letter-spacing: 0;
    }
    .section-head p {
      margin: 0;
      color: var(--muted);
      font-size: 1rem;
      line-height: 1.62;
    }
    .doc-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1px;
      border: 1px solid var(--ink);
      background: var(--ink);
    }
    .doc-block {
      background: var(--paper);
      min-width: 0;
      padding: 1.05rem;
    }
    .doc-block h3 {
      margin: 0;
      color: var(--ink);
      font-size: 1.04rem;
      line-height: 1.25;
    }
    .doc-block p,
    .doc-block li {
      color: var(--muted);
      font-size: .92rem;
      line-height: 1.55;
    }
    .doc-block p { margin: .58rem 0 0; }
    .doc-block ul { margin: .7rem 0 0; padding-left: 1.1rem; }
    .code {
      margin: .8rem 0 0;
      overflow-x: auto;
      background: var(--dark);
      color: #f8fafc;
      padding: .88rem;
      font-size: .78rem;
      line-height: 1.62;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .table {
      display: grid;
      border: 1px solid var(--ink);
      background: var(--paper);
    }
    .row {
      display: grid;
      grid-template-columns: minmax(10rem, .32fr) minmax(0, 1fr);
      border-bottom: 1px solid var(--line);
    }
    .row:last-child { border-bottom: 0; }
    .row b,
    .row span {
      padding: .9rem;
      line-height: 1.5;
    }
    .row b {
      color: var(--ink);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .78rem;
      overflow-wrap: anywhere;
    }
    .row span {
      color: var(--muted);
      border-left: 1px solid var(--line);
      font-size: .92rem;
    }
    .callout {
      border: 1px solid var(--line-dark);
      background: var(--green-soft);
      color: #174b3c;
      padding: 1rem;
      line-height: 1.58;
    }
    .footer {
      border-top: 1px solid var(--line);
      background: var(--paper);
      color: var(--muted);
      padding: 1.4rem 0;
      font-size: .9rem;
    }
    .footer-inner {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .footer a { color: var(--ink); font-weight: 700; }
    @media (max-width: 920px) {
      .hero,
      .section-head,
      .doc-grid {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 720px) {
      .shell { width: min(100% - 1rem, 1180px); }
      .topbar {
        align-items: flex-start;
        flex-direction: column;
        padding: .85rem 0;
      }
      .nav { flex-wrap: wrap; }
      h1 { font-size: 2.5rem; }
      .hero { padding-top: 2rem; }
      .row { grid-template-columns: 1fr; }
      .row span { border-left: 0; border-top: 1px solid var(--line); }
    }
  `;
}

function docsCode(value: string) {
  return `<pre class="code"><code>${escapeHtml(value)}</code></pre>`;
}

function docsMarkdown(_origin: string) {
  return `# AgentContract Docs

Canonical: ${publicUrl("/docs")}
Machine-readable source: ${publicUrl("/docs.md")}
Human HTML page: ${publicUrl("/docs")}
Product: Contract signing API and CLI for AI agents.
Current CLI version: ${currentCliVersion}

AgentContract lets AI agent workflows send approved NDAs, privacy acknowledgements, contractor agreements, and onboarding packets. Agents send approved packets only. Humans review and sign in the browser. The system returns signed PDFs, SHA-256 hashes, status, webhooks, and audit trails.

## Boundaries

- Use AgentContract for sending approved contract templates from agent workflows.
- Do not use AgentContract to let agents draft legal terms or sign contracts.
- Do not send an agreement until a human operator has approved the recipient, template, and dry-run output.
- Do not include secrets, API keys, raw private contract text, or unrelated personal data in session events or feedback messages.

## Safe Agent Workflow

1. Install the CLI.
2. Authenticate with an email code.
3. Run \`agentcontract skill\` and follow its instructions.
4. List available templates.
5. Read the selected template before sending.
6. Run the send command with \`--dry-run --json\`.
7. Show the dry-run JSON to the human operator.
8. Wait for explicit approval.
9. Send the agreement.
10. Return the agreement id, signing URL, and status.
11. Track status or wait for a webhook.

## Commands

\`\`\`sh
curl -fsSL https://agentcontract.to/cli/install.sh | bash
agentcontract login --email you@example.com --api-url https://agentcontract.to
agentcontract doctor --json
agentcontract skill
\`\`\`

\`\`\`sh
agentcontract templates --json
agentcontract template read privacy-policy --json
agentcontract marketplace-onboard --to jane@example.com --name "Jane Contributor" --dry-run --json
agentcontract marketplace-onboard --to jane@example.com --name "Jane Contributor" --json
agentcontract agreement status agr_123 --json
agentcontract agreement download agr_123 --out ./signed.pdf
\`\`\`

## Sessions

Use sessions to record agent workflow progress without leaking secrets or private contract language.

\`\`\`sh
agentcontract session start --tool codex --repo agentink --json
agentcontract session event --session-id sess_123 --kind progress --message "Read template and prepared dry run" --json
agentcontract session end --session-id sess_123 --status completed --json
\`\`\`

Good session events include template selection, dry-run review, human approval, send result, reminder attempts, cancellation, and failure details.

## API

Use the API when the sending workflow lives in your backend instead of a local CLI process. Store the returned agreement id for status polling or webhook correlation.

\`\`\`http
POST /v1/agreements
Authorization: Bearer ac_live_...
Content-Type: application/json

{
  "template_id": "privacy-policy",
  "recipient": {
    "email": "jane@example.com",
    "name": "Jane Contributor"
  },
  "variables": {
    "company_name": "Acme"
  },
  "metadata": {
    "source": "agent-workflow"
  }
}
\`\`\`

\`\`\`http
GET /v1/agreements/agr_123
GET /v1/agreements/agr_123/pdf
POST /v1/agreements/agr_123/remind
POST /v1/agreements/agr_123/cancel
\`\`\`

## Templates

- \`mutual-nda\`: two-way confidentiality packet for counterparties that exchange confidential information.
- \`one-way-nda\`: one-way confidentiality packet for vendors, reviewers, and external collaborators.
- \`privacy-policy\`: website and app privacy policy acknowledgement for controlled onboarding flows.

Public previews:

- https://agentcontract.to/templates/mutual-nda
- https://agentcontract.to/templates/one-way-nda
- https://agentcontract.to/templates/privacy-policy

## Webhooks

Treat webhook handlers as idempotent. Verify signatures, deduplicate events, fetch the agreement record, and store the signed PDF hash with your own record.

\`\`\`json
{
  "type": "agreement.completed",
  "agreement_id": "agr_123",
  "status": "completed",
  "signed_pdf_url": "https://agentcontract.to/v1/agreements/agr_123/pdf",
  "signed_pdf_sha256": "..."
}
\`\`\`

## Deployment

Production uses Supabase/Postgres-backed storage. Keep secrets in the deployment environment and run migrations with the production database URL.

\`\`\`sh
DATABASE_URL="postgres://..." npm run migrate -- --status
DATABASE_URL="postgres://..." npm run migrate
\`\`\`

Release checks:

- \`/healthz\` exposes current service and CLI version metadata.
- \`/cli/install.sh\` installs the hosted tarball.
- \`/sitemap.xml\`, \`/llms.txt\`, and \`/docs.md\` expose public docs only.
- Private dashboards, signing URLs, auth routes, and \`/v1/\` remain non-indexed.

## Troubleshooting

Use \`agentcontract feedback\` when a user reports install failures, stale versions, missing commands, HTTP 404s, or confusing output.

\`\`\`sh
agentcontract feedback --area sending --priority high --message "specific-privacy returned HTTP 404"
agentcontract feedback --area install --message "update reports success but active CLI stayed old" --json
\`\`\`

Common fixes:

- If update reports success but the version stays old, check which \`agentcontract\` binary is first on \`PATH\`.
- If a hosted update fails checksum validation, reinstall from https://agentcontract.to/cli/install.sh.
- If a send route returns HTTP 404, run \`agentcontract templates --json\` and confirm the template id is approved.
- If docs mention a missing command, run \`agentcontract update\` and then \`agentcontract --version --json\`.

## Agent Response Contract

When an agent sends or prepares an agreement, return:

- Agreement id.
- Template id.
- Recipient email and name.
- Whether the command was a dry run or real send.
- Signing URL when available.
- Current status.
- Any next step that needs human approval.
`;
}

function docsTopbar() {
  return `<header class="shell topbar">
    <a class="brand" href="/" aria-label="AgentContract home">
      <span class="mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M7 3.8h7.5L18 7.3v12.9H7V3.8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M14.2 4.1v3.4h3.4M9.8 11h4.8M9.8 14h4.2M9.8 17h3.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </span>
      AgentContract
    </a>
    <nav class="nav" aria-label="Docs navigation">
      <a href="#cli">CLI</a>
      <a href="#api">API</a>
      <a href="#webhooks">Webhooks</a>
      <a href="#troubleshooting">Troubleshooting</a>
      <a class="primary" href="/dashboard">Dashboard</a>
    </nav>
  </header>`;
}

function renderDocsPage(_origin: string) {
  const title = "AgentContract Docs | CLI, API, templates, webhooks, and troubleshooting";
  const description = "Complete AgentContract documentation for installing the CLI, authenticating, sending templates, using the API, handling webhooks, running migrations, and troubleshooting agent workflows.";
  const canonical = publicUrl("/docs");
  const installCommand = `curl -fsSL ${primaryOrigin}/cli/install.sh | bash
agentcontract login --email you@example.com --api-url ${primaryOrigin}
agentcontract doctor --json
agentcontract skill`;
  const sessionCommands = `agentcontract session start --tool codex --repo agentink --json
agentcontract session event --session-id sess_123 --kind progress --message "Read template and prepared dry run" --json
agentcontract session end --session-id sess_123 --status completed --json`;
  const sendCommand = `agentcontract marketplace-onboard --to jane@example.com --name "Jane Contributor" --dry-run --json
agentcontract marketplace-onboard --to jane@example.com --name "Jane Contributor" --json
agentcontract agreement status agr_123 --json
agentcontract agreement download agr_123 --out ./signed.pdf`;
  const apiCommand = `POST /v1/agreements
Authorization: Bearer ac_live_...
Content-Type: application/json

{
  "template_id": "privacy-policy",
  "recipient": {
    "email": "jane@example.com",
    "name": "Jane Contributor"
  },
  "variables": {
    "company_name": "Acme"
  },
  "metadata": {
    "source": "agent-workflow"
  }
}`;
  const webhookCommand = `{
  "type": "agreement.completed",
  "agreement_id": "agr_123",
  "status": "completed",
  "signed_pdf_url": "https://agentcontract.to/v1/agreements/agr_123/pdf",
  "signed_pdf_sha256": "..."
}`;
  const migrationCommand = `DATABASE_URL="postgres://..." npm run migrate -- --status
DATABASE_URL="postgres://..." npm run migrate`;
  const feedbackCommand = `agentcontract feedback --area sending --priority high --message "specific-privacy returned HTTP 404"
agentcontract feedback --area install --message "update reports success but active CLI stayed old" --json`;
  const structuredDataJson = jsonLd({
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: title,
    description,
    url: canonical,
    inLanguage: "en-US",
    articleSection: ["CLI", "API", "Templates", "Webhooks", "Troubleshooting"],
    publisher: {
      "@type": "Organization",
      name: "AgentContract",
      url: publicUrl()
    }
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta name="robots" content="index,follow,max-image-preview:large" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <link rel="alternate" type="text/markdown" href="${escapeHtml(publicUrl("/docs.md"))}" title="AgentContract docs markdown" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${escapeHtml(canonical)}" />
  <meta property="og:site_name" content="AgentContract" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <script type="application/ld+json">${structuredDataJson}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>${docsPageCss()}</style>
</head>
<body>
  ${docsTopbar()}
  <main>
    <section class="shell hero">
      <div>
        <span class="eyebrow">Documentation</span>
        <h1>AgentContract Docs</h1>
        <p class="lede">Install the CLI, authenticate, inspect approved templates, send agreements, wire API calls, receive webhook events, and diagnose the common problems that show up in agent-run contract workflows.</p>
      </div>
      <aside class="hero-panel" aria-label="AgentContract install quickstart">
        <header><span>Quickstart</span><span>CLI ${escapeHtml(currentCliVersion)}</span></header>
        ${docsCode(installCommand)}
      </aside>
    </section>

    <nav class="shell jump-strip" aria-label="Documentation sections">
      <a href="#quickstart">Quickstart</a>
      <a href="#cli">CLI</a>
      <a href="#sessions">Sessions</a>
      <a href="#api">API</a>
      <a href="#templates">Templates</a>
      <a href="#webhooks">Webhooks</a>
      <a href="#deployment">Deployment</a>
      <a href="#troubleshooting">Troubleshooting</a>
      <a href="/docs.md">Markdown</a>
    </nav>

    <section class="section" id="quickstart">
      <div class="shell">
        <div class="section-head">
          <h2>Quickstart</h2>
          <p>AgentContract is for approved, repeatable contract packets. Agents can read templates, run dry runs, send signing links, and report status. People still review and sign in the browser.</p>
        </div>
        <div class="doc-grid">
          <article class="doc-block">
            <h3>Install and log in</h3>
            <p>Use the hosted installer for Node.js 20+ machines. The CLI keeps local auth config on the machine that is running the agent.</p>
            ${docsCode(installCommand)}
          </article>
          <article class="doc-block">
            <h3>Agent setup prompt</h3>
            <p>Run <code>agentcontract skill</code> and paste the printed instructions into Codex, Claude Code, or another local agent. The skill tells the agent to preview templates, dry-run sends, and wait for approval before emailing a signer.</p>
            ${docsCode(`agentcontract skill
agentcontract templates --json
agentcontract template read privacy-policy --json`)}
          </article>
        </div>
      </div>
    </section>

    <section class="section" id="cli">
      <div class="shell">
        <div class="section-head">
          <h2>CLI</h2>
          <p>The CLI is the fastest path for local agents and scripts. It returns JSON for automation, supports dry runs, and exposes agreement lifecycle commands.</p>
        </div>
        <div class="doc-grid">
          <article class="doc-block">
            <h3>Send a packet</h3>
            <p>Start with a dry run, inspect the JSON, then send only after the human operator approves the recipient, template, and variables.</p>
            ${docsCode(sendCommand)}
          </article>
          <article class="doc-block">
            <h3>Command map</h3>
            <ul>
              <li><code>agentcontract login</code> authenticates with an email code.</li>
              <li><code>agentcontract templates</code> lists approved templates.</li>
              <li><code>agentcontract template read</code> previews template language before sending.</li>
              <li><code>agentcontract marketplace-onboard</code> sends the default onboarding packet.</li>
              <li><code>agentcontract update</code> upgrades and verifies the active binary.</li>
            </ul>
          </article>
        </div>
      </div>
    </section>

    <section class="section" id="sessions">
      <div class="shell">
        <div class="section-head">
          <h2>Sessions</h2>
          <p>Sessions let an agent log its contract workflow progress as durable events. Use them when you want feedback and support context tied to a single run.</p>
        </div>
        <div class="doc-grid">
          <article class="doc-block">
            <h3>Lifecycle commands</h3>
            ${docsCode(sessionCommands)}
          </article>
          <article class="doc-block">
            <h3>What to record</h3>
            <p>Record template selection, dry-run review, user approval, send result, reminder attempts, and failure details. Keep secrets, raw keys, and private contract text out of session messages.</p>
          </article>
        </div>
      </div>
    </section>

    <section class="section" id="api">
      <div class="shell">
        <div class="section-head">
          <h2>API</h2>
          <p>Use the API when the sending workflow lives in your backend instead of a local CLI process. Send approved templates and store the returned agreement id for status polling or webhook correlation.</p>
        </div>
        <div class="doc-grid">
          <article class="doc-block">
            <h3>POST /v1/agreements</h3>
            ${docsCode(apiCommand)}
          </article>
          <article class="doc-block">
            <h3>Auth and status</h3>
            <p>Use dashboard API keys or CLI-managed keys as bearer tokens. Store the agreement id, recipient email, template id, and metadata so later automation can reconcile completion events.</p>
            ${docsCode(`GET /v1/agreements/agr_123
GET /v1/agreements/agr_123/pdf
POST /v1/agreements/agr_123/remind
POST /v1/agreements/agr_123/cancel`)}
          </article>
        </div>
      </div>
    </section>

    <section class="section" id="templates">
      <div class="shell">
        <div class="section-head">
          <h2>Templates</h2>
          <p>Templates are approved packets with controlled variables. Public previews are available for the standard mutual NDA, one-way NDA, and privacy policy templates.</p>
        </div>
        <div class="table" role="table" aria-label="Template references">
          <div class="row" role="row"><b role="cell">mutual-nda</b><span role="cell">Two-way confidentiality packet for counterparties that exchange confidential information.</span></div>
          <div class="row" role="row"><b role="cell">one-way-nda</b><span role="cell">One-way confidentiality packet for vendors, reviewers, and external collaborators.</span></div>
          <div class="row" role="row"><b role="cell">privacy-policy</b><span role="cell">Website and app privacy policy acknowledgement for controlled onboarding flows.</span></div>
        </div>
      </div>
    </section>

    <section class="section" id="webhooks">
      <div class="shell">
        <div class="section-head">
          <h2>Webhooks</h2>
          <p>Webhooks let your app continue once a signer completes, cancels, or stalls on an agreement. Treat webhook handlers as idempotent and fetch agreement status before applying irreversible actions.</p>
        </div>
        <div class="doc-grid">
          <article class="doc-block">
            <h3>Completion event</h3>
            ${docsCode(webhookCommand)}
          </article>
          <article class="doc-block">
            <h3>Handler checklist</h3>
            <ul>
              <li>Verify the webhook signature before trusting the payload.</li>
              <li>Deduplicate by event id or agreement id plus status.</li>
              <li>Fetch the agreement record before unlocking the next workflow step.</li>
              <li>Store the signed PDF SHA-256 hash with your own record.</li>
            </ul>
          </article>
        </div>
      </div>
    </section>

    <section class="section" id="deployment">
      <div class="shell">
        <div class="section-head">
          <h2>Deployment</h2>
          <p>Production uses Supabase/Postgres-backed storage. Keep secrets in the deployment environment, run migrations with the production database URL, and verify CLI metadata after deploy.</p>
        </div>
        <div class="doc-grid">
          <article class="doc-block">
            <h3>Migrations</h3>
            ${docsCode(migrationCommand)}
          </article>
          <article class="doc-block">
            <h3>Release checks</h3>
            <ul>
              <li><code>/healthz</code> exposes the current hosted CLI version.</li>
              <li><code>/cli/install.sh</code> installs the hosted tarball.</li>
              <li><code>/sitemap.xml</code> and <code>/llms.txt</code> list public docs pages only.</li>
              <li>Private dashboards, signing URLs, auth routes, and <code>/v1/</code> stay out of crawlable docs.</li>
            </ul>
          </article>
        </div>
      </div>
    </section>

    <section class="section" id="troubleshooting">
      <div class="shell">
        <div class="section-head">
          <h2>Troubleshooting</h2>
          <p>Most user-reported issues land in four places: install/update, login, send routes, or docs drift. Capture feedback from the CLI as soon as the user hits a blocker.</p>
        </div>
        <div class="doc-grid">
          <article class="doc-block">
            <h3>Report feedback</h3>
            <p>Use <code>agentcontract feedback</code> when a user sees a failed install, stale version, missing command, 404, or confusing response.</p>
            ${docsCode(feedbackCommand)}
          </article>
          <article class="doc-block">
            <h3>Common fixes</h3>
            <ul>
              <li>If update reports success but the version stays old, check which <code>agentcontract</code> binary is first on <code>PATH</code>.</li>
              <li>If a hosted update fails checksum validation, reinstall from <code>${primaryOrigin}/cli/install.sh</code>.</li>
              <li>If a send route returns HTTP 404, run <code>agentcontract templates --json</code> and confirm the template id is approved.</li>
              <li>If docs mention a missing command, run <code>agentcontract update</code> and then <code>agentcontract --version --json</code>.</li>
            </ul>
          </article>
        </div>
        <p class="callout">AgentContract does not let agents draft terms or sign contracts. The safe loop is: read approved template, dry run, show the human, get approval, send, then track the signed record.</p>
      </div>
    </section>
  </main>
  <footer class="footer">
    <div class="shell footer-inner">
      <span>AgentContract docs for agent-sent, human-signed contracts.</span>
      <span><a href="/cli">CLI page</a> · <a href="/templates">Templates</a> · <a href="/healthz">Status</a></span>
    </div>
  </footer>
</body>
</html>`;
}

function cliVersionMetadata(origin: string) {
  return {
    name: "AgentContract",
    ok: true,
    version: currentCliVersion,
    cli: {
      package: cliPackageName,
      version: currentCliVersion,
      minimum_version: currentCliVersion,
      install_url: `${origin}/cli/install.sh`,
      install_command: `curl -fsSL ${origin}/cli/install.sh | bash`
    }
  };
}

function wantsJson(accept: string, format: string | undefined) {
  if (format === "json") return true;
  return accept
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .some((part) => part === "application/json" || part.startsWith("application/json;"));
}

function homePage(origin: string) {
  const safeOrigin = escapeHtml(origin);
  const safeCanonical = escapeHtml(publicUrl());
  const installCommand = `curl -fsSL ${origin}/cli/install.sh | bash`;
  const agentPrompt = `Set up AgentContract for this machine.

Run:
curl -fsSL ${primaryOrigin}/cli/install.sh | bash
agentcontract login --email <my-email> --api-url ${primaryOrigin}
agentcontract skill

If you do not know my email, ask first.

For any contract send:
- ask for recipient email, recipient name, and template
- run agentcontract templates --json
- read the chosen template before sending
- run the send with --dry-run --json
- show me the dry-run JSON and wait for approval
- only send after I approve
- return the agreement id, signing URL, and status

Never draft or edit legal terms.`;
  const structuredDataJson = jsonLd(structuredData(primaryOrigin));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(pageDescription)}" />
  <meta name="robots" content="index,follow,max-image-preview:large" />
  <link rel="canonical" href="${safeCanonical}" />
  <link rel="alternate" type="text/plain" href="${escapeHtml(publicUrl("/llms.txt"))}" title="llms.txt" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${safeCanonical}" />
  <meta property="og:site_name" content="AgentContract" />
  <meta property="og:title" content="${escapeHtml(pageTitle)}" />
  <meta property="og:description" content="${escapeHtml(pageDescription)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(pageDescription)}" />
  <script type="application/ld+json">${structuredDataJson}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --paper: #ffffff;
      --ink: #080b12;
      --text: #1b2433;
      --muted: #697386;
      --quiet: #929aab;
      --line: #d9dfeb;
      --line-dark: #aeb7c8;
      --blue: #194fe5;
      --blue-soft: #eef3ff;
      --green: #0d7659;
      --green-soft: #e9f7f1;
      --amber: #9b6400;
      --amber-soft: #fff6df;
      --dark: #0c111d;
      --shadow: 0 30px 90px rgba(15, 23, 42, .12);
    }

    * { box-sizing: border-box; }

    html { scroll-behavior: smooth; }

    body {
      margin: 0;
      background:
        linear-gradient(90deg, rgba(8, 11, 18, .045) 1px, transparent 1px),
        linear-gradient(180deg, rgba(8, 11, 18, .045) 1px, transparent 1px),
        var(--bg);
      background-size: 4.6rem 4.6rem;
      color: var(--text);
      font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0;
    }

    a { color: inherit; text-decoration: none; }
    button { font: inherit; }
    code, pre { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }

    .shell {
      width: min(100% - 2rem, 1180px);
      margin: 0 auto;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      min-height: 4.5rem;
      border-bottom: 1px solid var(--line);
      background: rgba(247, 248, 251, .82);
      backdrop-filter: blur(14px);
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: .7rem;
      color: var(--ink);
      font-size: 1rem;
      font-weight: 700;
    }

    .mark {
      display: grid;
      place-items: center;
      width: 2.05rem;
      height: 2.05rem;
      border: 1px solid var(--ink);
      background: var(--paper);
    }

    .mark svg { display: block; }

    .nav {
      display: flex;
      align-items: center;
      gap: .35rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .82rem;
      font-weight: 700;
      text-transform: uppercase;
    }

    .nav a {
      border: 1px solid transparent;
      padding: .62rem .75rem;
    }

    .nav a:hover {
      border-color: var(--line-dark);
      color: var(--ink);
      background: rgba(255,255,255,.65);
    }

    .nav .docs {
      border-color: var(--line-dark);
      color: var(--ink);
      background: rgba(255,255,255,.78);
    }

    .nav .start {
      border-color: var(--ink);
      background: var(--ink);
      color: white;
    }

    .hero {
      display: grid;
      grid-template-columns: minmax(0, .9fr) minmax(31rem, 1.1fr);
      gap: clamp(2rem, 5vw, 4.8rem);
      align-items: start;
      padding: clamp(3.2rem, 6vw, 5rem) 0 clamp(2.2rem, 5vw, 4rem);
    }

    .yc {
      display: inline-flex;
      align-items: center;
      gap: .48rem;
      margin-bottom: 1.15rem;
      border: 1px solid var(--line-dark);
      background: var(--paper);
      color: var(--muted);
      padding: .42rem .55rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .76rem;
      font-weight: 700;
      text-transform: uppercase;
    }

    .yc b {
      display: inline-grid;
      place-items: center;
      width: 1.15rem;
      height: 1.15rem;
      background: var(--blue);
      color: white;
      font-family: "IBM Plex Sans", ui-sans-serif, sans-serif;
      font-size: .75rem;
      line-height: 1;
    }

    .hero h1 {
      margin: 0;
      max-width: 11ch;
      color: var(--ink);
      font-size: clamp(2.85rem, 4.8vw, 4.85rem);
      line-height: 1;
      font-weight: 600;
      letter-spacing: 0;
    }

    .hero h1 span {
      color: var(--blue);
    }

    .hero p {
      margin: 1.25rem 0 0;
      max-width: 34rem;
      color: var(--muted);
      font-size: clamp(1.03rem, 1.45vw, 1.18rem);
      line-height: 1.6;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: .72rem;
      margin-top: 1.55rem;
    }

    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.9rem;
      border: 1px solid var(--ink);
      padding: .72rem 1rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .82rem;
      font-weight: 700;
      text-transform: uppercase;
      white-space: nowrap;
      transition: transform .15s ease, background .15s ease;
    }

    .button:active { transform: translateY(1px); }
    .button.primary { background: var(--ink); color: white; }
    .button.primary:hover { background: #000; }
    .button.secondary { background: var(--paper); color: var(--ink); }
    .button.secondary:hover { background: #eef1f6; }

    .fine-print {
      margin-top: 1rem;
      color: var(--quiet);
      font-size: .9rem;
    }

    .hero-product {
      display: grid;
      gap: 1rem;
    }

    .code-window,
    .live-window {
      border: 1px solid var(--ink);
      background: var(--paper);
      box-shadow: var(--shadow);
    }

    .code-tabs {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--line-dark);
    }

    .prompt-label {
      padding: .78rem .9rem;
      color: var(--ink);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .76rem;
      font-weight: 700;
    }

    .copy-button {
      margin-right: .75rem;
      border: 1px solid var(--line-dark);
      background: var(--paper);
      color: var(--ink);
      cursor: pointer;
      padding: .34rem .48rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .7rem;
      font-weight: 700;
    }

    .code-window pre {
      margin: 0;
      min-height: 16rem;
      overflow-x: auto;
      padding: 1.25rem;
      color: #1f2937;
      font-size: .9rem;
      line-height: 1.72;
      white-space: pre-wrap;
    }

    .live-window {
      display: grid;
      grid-template-columns: .92fr 1.08fr;
      min-height: 12rem;
      box-shadow: 0 16px 50px rgba(15, 23, 42, .08);
    }

    .live-head {
      grid-column: 1 / -1;
      border-bottom: 1px solid var(--line-dark);
      padding: .78rem .9rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .76rem;
      font-weight: 700;
    }

    .packet {
      border-right: 1px solid var(--line);
      padding: .9rem;
    }

    .packet b {
      display: block;
      max-width: 14rem;
      color: var(--ink);
      font-size: 1rem;
      line-height: 1.2;
    }

    .packet span {
      display: block;
      margin-top: .45rem;
      color: var(--muted);
      font-size: .82rem;
      line-height: 1.4;
    }

    .proof {
      display: grid;
      gap: .62rem;
      padding: .9rem;
    }

    .proof-row {
      display: grid;
      grid-template-columns: 3.7rem 1fr;
      gap: .6rem;
      align-items: start;
      border-bottom: 1px solid var(--line);
      padding-bottom: .62rem;
    }

    .proof-row:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }

    .proof-row code {
      color: var(--blue);
      font-size: .7rem;
      font-weight: 700;
      text-transform: uppercase;
    }

    .proof-row strong {
      display: block;
      color: var(--ink);
      font-size: .86rem;
      line-height: 1.25;
    }

    .proof-row small {
      display: block;
      margin-top: .16rem;
      color: var(--muted);
      font-size: .76rem;
      line-height: 1.35;
    }

    .logos {
      margin-top: 2rem;
      color: var(--muted);
      text-align: center;
      font-size: .98rem;
    }

    .logo-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      margin-top: .9rem;
    }

    .logo {
      border-right: 1px solid var(--line);
      padding: 1.15rem .6rem;
      color: var(--ink);
      font-weight: 700;
      opacity: .66;
    }

    .logo:last-child { border-right: 0; }

    .section {
      padding: clamp(3rem, 7vw, 5.5rem) 0;
      border-top: 1px solid var(--line);
      background: rgba(255,255,255,.42);
    }

    .section-head {
      display: grid;
      grid-template-columns: .78fr .58fr;
      gap: 2rem;
      align-items: end;
      margin-bottom: 1.6rem;
    }

    .section h2 {
      margin: 0;
      max-width: 13ch;
      color: var(--ink);
      font-size: clamp(2rem, 3.8vw, 3.25rem);
      line-height: 1.04;
      font-weight: 600;
      letter-spacing: 0;
    }

    .section-head p {
      margin: 0;
      color: var(--muted);
      font-size: 1rem;
      line-height: 1.62;
    }

    .offer {
      display: grid;
      grid-template-columns: .72fr 1.28fr;
      border: 1px solid var(--ink);
      background: var(--paper);
    }

    .offer-nav {
      border-right: 1px solid var(--ink);
    }

    .offer-item {
      border-bottom: 1px solid var(--line);
      padding: 1rem;
      color: var(--muted);
      font-weight: 700;
    }

    .offer-item.active {
      color: var(--ink);
      background: var(--blue-soft);
    }

    .offer-body {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      padding: 1rem;
    }

    .offer-copy h3 {
      margin: 0;
      color: var(--ink);
      font-size: 1.35rem;
      line-height: 1.2;
    }

    .offer-copy p {
      margin: .65rem 0 0;
      color: var(--muted);
      line-height: 1.55;
    }

    .contract-card {
      border: 1px solid var(--line-dark);
      background: #fbfcff;
      padding: .9rem;
    }

    .contract-card h4 {
      margin: 0;
      color: var(--ink);
      line-height: 1.22;
    }

    .contract-line {
      height: .5rem;
      border-radius: 999px;
      background: #dfe5ef;
      margin-top: .58rem;
    }

    .contract-line:nth-child(3) { width: 88%; }
    .contract-line:nth-child(4) { width: 74%; }
    .contract-line:nth-child(5) { width: 92%; }

    .numbers {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1px;
      border: 1px solid var(--ink);
      background: var(--ink);
    }

    .metric {
      background: var(--paper);
      padding: 1.25rem;
    }

    .metric b {
      display: block;
      color: var(--ink);
      font-size: clamp(1.65rem, 3vw, 2.55rem);
      line-height: 1;
      letter-spacing: 0;
    }

    .metric span {
      display: block;
      margin-top: .5rem;
      color: var(--muted);
      font-size: .92rem;
      line-height: 1.45;
    }

    .dark {
      background: var(--dark);
      color: white;
    }

    .dark .section {
      background: transparent;
      border-top-color: rgba(255,255,255,.12);
    }

    .dark h2 { color: white; }
    .dark .section-head p { color: #aeb8c9; }

    .cli-grid {
      display: grid;
      grid-template-columns: 1.05fr .95fr;
      gap: 1rem;
    }

    .dark-code,
    .use-case {
      border: 1px solid rgba(255,255,255,.16);
      background: rgba(255,255,255,.045);
    }

    .dark-code {
      overflow: hidden;
      background: #0f172a;
    }

    .dark-code header {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      border-bottom: 1px solid rgba(255,255,255,.14);
      padding: .82rem .95rem;
      color: #aeb8c9;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .74rem;
      font-weight: 700;
    }

    .dark-code pre {
      margin: 0;
      padding: 1rem;
      color: #eef2ff;
      font-size: .82rem;
      line-height: 1.65;
      white-space: pre-wrap;
      overflow-x: auto;
    }

    .use-cases {
      display: grid;
      gap: .75rem;
    }

    .use-case {
      padding: 1rem;
    }

    .use-case b {
      display: block;
      color: white;
      font-size: .98rem;
    }

    .use-case span {
      display: block;
      margin-top: .34rem;
      color: #aeb8c9;
      font-size: .88rem;
      line-height: 1.5;
    }

    .faq-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      border: 1px solid var(--ink);
      background: var(--paper);
    }

    .faq {
      min-height: 9rem;
      border-right: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      padding: 1rem;
    }

    .faq:nth-child(2n) { border-right: 0; }
    .faq:nth-last-child(-n + 2) { border-bottom: 0; }

    .faq h3 {
      margin: 0;
      color: var(--ink);
      font-size: 1.02rem;
    }

    .faq p {
      margin: .5rem 0 0;
      color: var(--muted);
      font-size: .9rem;
      line-height: 1.5;
    }

    .final {
      display: grid;
      grid-template-columns: .85fr 1.15fr;
      gap: 2rem;
      align-items: center;
      padding: clamp(3rem, 7vw, 5.4rem) 0;
      border-top: 1px solid var(--line);
    }

    .final h2 {
      margin: 0;
      color: var(--ink);
      font-size: clamp(2rem, 3.8vw, 3.25rem);
      line-height: 1.04;
      font-weight: 600;
    }

    .final p {
      margin: .9rem 0 0;
      color: var(--muted);
      font-size: 1rem;
      line-height: 1.58;
    }

    .cta {
      border: 1px solid var(--ink);
      background: var(--paper);
      padding: 1rem;
    }

    .cta code {
      display: block;
      border: 1px solid var(--line);
      background: #fbfcff;
      color: var(--ink);
      padding: .9rem;
      font-size: .84rem;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    .footer {
      border-top: 1px solid var(--line);
      background: var(--paper);
      color: var(--muted);
      padding: 1.5rem 0;
      font-size: .88rem;
    }

    .footer-inner {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .footer a {
      color: var(--ink);
      font-weight: 700;
    }

    @media (max-width: 980px) {
      .nav { display: none; }
      .hero,
      .section-head,
      .offer,
      .offer-body,
      .cli-grid,
      .final {
        grid-template-columns: 1fr;
      }
      .hero { min-height: auto; }
      .offer-nav { border-right: 0; border-bottom: 1px solid var(--ink); }
      .live-window { grid-template-columns: 1fr; }
      .packet { border-right: 0; border-bottom: 1px solid var(--line); }
      .logo-grid { grid-template-columns: repeat(2, 1fr); }
      .logo { border-bottom: 1px solid var(--line); }
      .numbers { grid-template-columns: 1fr; }
    }

    @media (max-width: 620px) {
      .shell { width: min(100% - 1rem, 1180px); }
      .topbar { min-height: 3.8rem; }
      .hero { padding: 2.2rem 0; }
      .hero h1 { font-size: 2.65rem; }
      .actions .button { width: 100%; }
      .code-window pre,
      .dark-code pre,
      .cta code {
        font-size: .72rem;
      }
      .logo-grid,
      .faq-grid {
        grid-template-columns: 1fr;
      }
      .faq,
      .faq:nth-child(2n),
      .faq:nth-last-child(-n + 2) {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .faq:last-child { border-bottom: 0; }
      .section h2,
      .final h2 {
        font-size: 2.15rem;
      }
    }
  </style>
</head>
<body>
  <header class="shell topbar">
    <a class="brand" href="/" aria-label="AgentContract home">
      <span class="mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M7 3.8h7.5L18 7.3v12.9H7V3.8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M14.2 4.1v3.4h3.4M9.8 11h4.8M9.8 14h4.2M9.8 17h3.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </span>
      AgentContract
    </a>
    <nav class="nav" aria-label="Primary navigation">
      <a href="#offer">Enterprise</a>
      <a href="#scale">Proof</a>
      <a href="#api">API</a>
      <a href="/blog">Blog</a>
      <a href="/templates">Templates</a>
      <a class="docs" href="/docs">Docs</a>
      <a class="start" href="/dashboard">Dashboard</a>
    </nav>
  </header>

  <main>
    <section class="shell hero">
      <div>
        <div class="yc"><b>A</b> For agent-run onboarding</div>
        <h1>Agents send contracts. <span>People sign.</span></h1>
        <p>Let agents send NDAs, contracts, and PDFs. Humans sign in their browser. You get the signed PDF and a webhook.</p>
        <div class="actions">
          <a class="button primary" href="/cli">Start with CLI</a>
          <a class="button secondary" href="/templates">View templates</a>
        </div>
        <div class="fine-print">Free during beta. Agents do not sign. Agents only send what you approved.</div>
      </div>

      <div class="hero-product" aria-label="AgentContract product preview">
        <div class="code-window">
          <div class="code-tabs">
            <div class="prompt-label">Paste this into your agent</div>
            <button class="copy-button" type="button" data-copy="${escapeHtml(agentPrompt)}">Copy</button>
          </div>
          <pre><code>${escapeHtml(agentPrompt)}</code></pre>
        </div>

        <div class="live-window">
          <div class="live-head">Live Agreement</div>
          <div class="packet">
            <b>Acme Marketplace Privacy Acknowledgement</b>
            <span>Recipient: Jane Contributor</span>
            <span>Status: waiting on recipient signature</span>
          </div>
          <div class="proof">
            <div class="proof-row">
              <code>Send</code>
              <div><strong>Agent sent approved document</strong><small>Template and fields are locked.</small></div>
            </div>
            <div class="proof-row">
              <code>Sign</code>
              <div><strong>Recipient signs in browser</strong><small>Consent and time are recorded.</small></div>
            </div>
            <div class="proof-row">
              <code>Store</code>
              <div><strong>Signed PDF saved</strong><small>PDF and hash are saved.</small></div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="shell logos" aria-label="Use cases">
      <p>Built for the agent workflows where paperwork blocks the next step.</p>
      <div class="logo-grid">
        <div class="logo">Onboarding</div>
        <div class="logo">Marketplaces</div>
        <div class="logo">Contractors</div>
        <div class="logo">Compliance</div>
        <div class="logo">Internal Ops</div>
      </div>
    </section>

    <section class="shell section" id="offer">
      <div class="section-head">
        <h2>What AgentContract does.</h2>
        <p>Agents send templates or PDFs. People sign. Your app gets the result.</p>
      </div>
      <div class="offer">
        <div class="offer-nav">
          <div class="offer-item active">Use a locked template</div>
          <div class="offer-item">Send an existing PDF</div>
          <div class="offer-item">Let people sign</div>
          <div class="offer-item">Get PDFs and webhooks</div>
        </div>
        <div class="offer-body">
          <div class="offer-copy">
            <h3>Approved templates in. Signed PDFs out.</h3>
            <p>Agents fill in template variables or send a PDF you give them. They cannot change the terms; a human signs.</p>
          </div>
          <div class="contract-card">
            <h4>Acme Marketplace Privacy Acknowledgement</h4>
            <div class="contract-line"></div>
            <div class="contract-line"></div>
            <div class="contract-line"></div>
            <div class="contract-line"></div>
          </div>
        </div>
      </div>
    </section>

    <section class="shell section" id="scale">
      <div class="section-head">
        <h2>What you get back.</h2>
        <p>After someone signs, your app can fetch:</p>
      </div>
      <div class="numbers">
        <div class="metric">
          <b>PDF</b>
          <span>Download the final signed document.</span>
        </div>
        <div class="metric">
          <b>Hash</b>
          <span>Verify the PDF did not change.</span>
        </div>
        <div class="metric">
          <b>Webhook</b>
          <span>Know when it is signed, cancelled, or waiting.</span>
        </div>
      </div>
    </section>

    <div class="dark" id="api">
      <section class="shell section">
        <div class="section-head">
          <h2>Give your agent a send command.</h2>
          <p>Humans use the dashboard. Agents use the CLI or API.</p>
        </div>
        <div class="cli-grid">
          <div class="dark-code">
            <header>
              <span>quickstart</span>
              <button class="copy-button" type="button" data-copy="${escapeHtml(installCommand)}">Copy</button>
            </header>
            <pre><code>${escapeHtml(installCommand)}
agentcontract login --email you@example.com --api-url ${safeOrigin}
agentcontract skill
agentcontract marketplace-onboard --to jane@example.com --name "Jane Contributor"</code></pre>
          </div>
          <div class="use-cases">
            <div class="use-case">
              <b>Read before sending</b>
              <span>Agents can preview the document first.</span>
            </div>
            <div class="use-case">
              <b>Track without the dashboard</b>
              <span>Check status, send reminders, cancel sends, and download PDFs.</span>
            </div>
            <div class="use-case">
              <b>Report failures immediately</b>
              <span>Capture install and login issues before they block a send.</span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <section class="shell section">
      <div class="section-head">
        <h2>FAQ.</h2>
        <p>AgentContract lets agents send contracts. It does not make agents legal signers.</p>
      </div>
      <div class="faq-grid">
        <div class="faq">
          <h3>Do agents sign contracts?</h3>
          <p>No. Agents send approved documents. People sign in the browser.</p>
        </div>
        <div class="faq">
          <h3>Can I use custom templates?</h3>
          <p>Yes. You can use templates, variables, required fields, metadata, and webhooks.</p>
        </div>
        <div class="faq">
          <h3>What gets stored?</h3>
          <p>Status, signer fields, events, signed PDFs, hashes, and completion time.</p>
        </div>
        <div class="faq">
          <h3>Is this only a dashboard?</h3>
          <p>No. Agents can use the CLI or API. Humans can inspect sends and manage keys.</p>
        </div>
        <div class="faq">
          <h3>Why not just use DocuSign or Dropbox Sign?</h3>
          <p>You probably can. AgentContract is shaped for agent workflows. Each key has rate limits. There is a dry-run mode. There is a kill switch that revokes a key and cancels its in-flight sends. If your sending is human-driven, DocuSign is fine.</p>
        </div>
        <div class="faq">
          <h3>What happens if my agent goes haywire and sends 500 NDAs?</h3>
          <p>Every key has daily and per-minute send caps. Revoke a key from the CLI or dashboard. That also cancels every in-flight agreement that key created.</p>
        </div>
        <div class="faq">
          <h3>Can the agent change the terms of the contract?</h3>
          <p>No. Agents fill in template variables or send a PDF as-is. They cannot edit the language.</p>
        </div>
        <div class="faq">
          <h3>How does the recipient know this is real and not a phishing email?</h3>
          <p>They open a browser signing page on agentcontract.to. It shows the document, sender, and fields. It feels like any other e-signature flow.</p>
        </div>
        <div class="faq">
          <h3>Is this legally binding?</h3>
          <p>A signed PDF from AgentContract is like one from any e-signature tool. Enforcement depends on the contract and your jurisdiction.</p>
        </div>
        <div class="faq">
          <h3>What happens if the recipient never signs?</h3>
          <p>It stays in waiting status until you cancel it or send a reminder. You can do both from the CLI.</p>
        </div>
        <div class="faq">
          <h3>Do you train on documents sent through this?</h3>
          <p>No.</p>
        </div>
        <div class="faq">
          <h3>Is there a free tier?</h3>
          <p>Free during beta.</p>
        </div>
        <div class="faq">
          <h3>Can I self-host?</h3>
          <p>Not yet.</p>
        </div>
      </div>
    </section>

    <section class="shell final">
      <div>
        <h2>Let an agent send the next contract.</h2>
        <p>Install the CLI. Log in with an email code. Let your agent send the document.</p>
      </div>
      <div class="cta">
        <code>${escapeHtml(installCommand)}</code>
        <div class="actions">
          <a class="button primary" href="/cli">Set up CLI</a>
          <a class="button secondary" href="/templates">Open templates</a>
        </div>
        <div class="fine-print">Free during beta.</div>
      </div>
    </section>
  </main>

  <footer class="footer">
    <div class="shell footer-inner">
      <span>AgentContract turns agent-sent paperwork into signed records.</span>
      <span>Contact: <a href="mailto:janak@withspecific.com">janak@withspecific.com</a></span>
      <span><a href="/blog">Blog</a> · <a href="/docs">Docs</a> · <a href="/cli">CLI</a> · <a href="/dashboard">Dashboard</a> · <a href="/healthz">Status</a></span>
    </div>
  </footer>

  <script>
    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        const value = button.getAttribute("data-copy") || "";
        const original = button.textContent;
        try {
          await navigator.clipboard.writeText(value);
          button.textContent = "Copied";
          setTimeout(() => { button.textContent = original; }, 1300);
        } catch {
          button.textContent = "Select";
          setTimeout(() => { button.textContent = original; }, 1300);
        }
      });
    });
  </script>
</body>
</html>`;
}

site.get("/", (c) => {
  const origin = new URL(c.req.url).origin;
  if (wantsJson(c.req.header("accept") ?? "", c.req.query("format"))) return c.json(cliVersionMetadata(origin));
  return c.html(homePage(origin));
});

site.get("/blog", (c) => c.html(renderBlogIndex(new URL(c.req.url).origin)));

site.get("/templates", (c) => c.html(renderPublicTemplatesPage(new URL(c.req.url).origin)));

site.get("/docs", (c) => c.html(renderDocsPage(new URL(c.req.url).origin)));

site.get("/docs.md", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.text(docsMarkdown(origin), 200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Cache-Control": "public, max-age=3600"
  });
});

for (const id of publicTemplateIds) {
  site.get(`/templates/${id}`, (c) => c.html(renderPublicTemplatePage(new URL(c.req.url).origin, id)));
}

for (const page of publicSeoPages) {
  site.get(page.path, (c) => c.html(renderSeoPage(page)));
}

for (const post of allBlogPosts) {
  site.get(`/blog/${post.slug}`, (c) => c.html(renderBlogPost(new URL(c.req.url).origin, post)));
}

site.get("/healthz", (c) => c.json(cliVersionMetadata(new URL(c.req.url).origin)));

site.get("/robots.txt", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.text(robotsTxt(origin), 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=3600"
  });
});

site.get("/sitemap.xml", (c) => {
  const origin = new URL(c.req.url).origin;
  return new Response(sitemapXml(origin), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    }
  });
});

site.get("/llms.txt", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.text(llmsTxt(origin), 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=3600"
  });
});
