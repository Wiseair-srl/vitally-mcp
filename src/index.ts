#!/usr/bin/env node

/**
 * Copyright (c) 2024 John Jung
 * Copyright (c) 2026 Wiseair S.r.l.
 *
 * Vitally MCP Server (Wiseair fork)
 *
 * MCP server for the Vitally REST API. Exposes account, user, task, project,
 * note, conversation, organization, custom-object record, meeting, NPS,
 * survey, and admin data with first-class trait/MRR/health fields and
 * explicit cursor pagination.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import fetch from "node-fetch";

// ---------------------------------------------------------------------------
// Logging — stderr only. The MCP stdio transport uses stdout for JSON-RPC, so
// any stray write to stdout corrupts the protocol stream.
// ---------------------------------------------------------------------------

function log(...parts: unknown[]): void {
  process.stderr.write(parts.map(p => (typeof p === "string" ? p : JSON.stringify(p))).join(" ") + "\n");
}

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

interface VitallyAccount {
  id: string;
  name: string;
  externalId?: string;
  traits?: Record<string, unknown>;
  mrr?: number;
  nextRenewalDate?: string;
  churnedAt?: string;
  trialEndDate?: string;
  usersCount?: number;
  npsScore?: number | null;
  healthScore?: number | null;
  csmId?: string;
  accountExecutiveId?: string;
  segments?: unknown[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface VitallyUser {
  id: string;
  name?: string;
  email?: string;
  externalId?: string;
  accountId?: string;
  account?: VitallyAccount;
  [key: string]: unknown;
}

interface VitallyPaginatedResponse<T> {
  results: T[];
  next: string | null;
}

interface VitallyConversation {
  id: string;
  subject?: string;
  externalId?: string;
  externalUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  account?: VitallyAccount;
  accountId?: string;
  [key: string]: unknown;
}

interface VitallyTask {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  dueDate?: string;
  completedAt?: string | null;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  account?: VitallyAccount;
  accountId?: string;
  [key: string]: unknown;
}

interface VitallyNote {
  id: string;
  content?: string;
  note?: string;
  subject?: string;
  noteDate?: string;
  createdAt?: string;
  updatedAt?: string;
  account?: VitallyAccount;
  accountId?: string;
  [key: string]: unknown;
}

interface VitallyProject {
  id: string;
  name?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  account?: VitallyAccount;
  [key: string]: unknown;
}

interface VitallyOrganization {
  id: string;
  name?: string;
  externalId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Environment & API configuration
// ---------------------------------------------------------------------------

const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  log(`Loaded environment from ${envPath}`);
} else {
  log(`Warning: No .env file found at ${envPath}`);
}

const VITALLY_SUBDOMAIN = process.env.VITALLY_API_SUBDOMAIN || "nylas";
const VITALLY_API_KEY = process.env.VITALLY_API_KEY;
const VITALLY_DATA_CENTER = (process.env.VITALLY_DATA_CENTER || "US").toUpperCase();

const API_BASE_URL = VITALLY_DATA_CENTER === "EU"
  ? "https://rest.vitally-eu.io"
  : `https://${VITALLY_SUBDOMAIN}.rest.vitally.io`;

const DEMO_MODE = !VITALLY_API_KEY || VITALLY_API_KEY === "your_api_key_here";
if (DEMO_MODE) {
  log("VITALLY_API_KEY is not set; starting in DEMO MODE with mock data.");
}

// Test-only: when VITALLY_DEMO_NULL_SCORES=1, mock accounts return null
// health/NPS so the workspace-warnings code path can be exercised.
const DEMO_NULL_SCORES = process.env.VITALLY_DEMO_NULL_SCORES === "1";

const AUTH_HEADER = `Basic ${Buffer.from(`${VITALLY_API_KEY ?? ""}:`).toString("base64")}`;

// ---------------------------------------------------------------------------
// Vitally API client
// ---------------------------------------------------------------------------

async function callVitallyAPI<T>(endpoint: string, method: string = "GET", body?: unknown): Promise<T> {
  if (DEMO_MODE) {
    return mockApiResponse<T>(endpoint, method, body);
  }

  const url = `${API_BASE_URL}${endpoint}`;
  const init: Parameters<typeof fetch>[1] = {
    method,
    headers: {
      Authorization: AUTH_HEADER,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined && (method === "POST" || method === "PUT" || method === "PATCH")) {
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error calling Vitally ${method} ${endpoint}: ${msg}`);
  }

  const remainingHeader = response.headers.get("x-ratelimit-remaining");
  if (remainingHeader !== null) {
    const remaining = parseInt(remainingHeader, 10);
    if (!Number.isNaN(remaining) && remaining < 50) {
      log(`[vitally-mcp] rate limit low: ${remaining} remaining on ${method} ${endpoint}`);
    }
  }

  if (!response.ok) {
    let errBody = "";
    try {
      errBody = await response.text();
    } catch {
      // ignore secondary read failures
    }
    throw new Error(
      `Vitally API ${response.status} ${response.statusText} on ${method} ${endpoint}` +
        (errBody ? `: ${errBody}` : "")
    );
  }

  return (await response.json()) as T;
}

function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    sp.append(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function paginate<T>(
  endpoint: string,
  params: Record<string, string | number | boolean | undefined | null>
): Promise<VitallyPaginatedResponse<T>> {
  return callVitallyAPI<VitallyPaginatedResponse<T>>(`${endpoint}${buildQuery(params)}`);
}

// ---------------------------------------------------------------------------
// Account serialization & helpers
// ---------------------------------------------------------------------------

function serializeAccount(account: VitallyAccount): VitallyAccount & { uri: string } {
  return {
    ...account,
    uri: `vitally://account/${account.id}`,
  };
}

function projectAccount(account: VitallyAccount, includeTraits: boolean, traits?: string[] | null) {
  const base = {
    ...account,
    uri: `vitally://account/${account.id}`,
  };
  if (Array.isArray(traits) && traits.length > 0) {
    const fullTraits = (account.traits || {}) as Record<string, unknown>;
    const slim: Record<string, unknown> = {};
    for (const k of traits) slim[k] = fullTraits[k] ?? null;
    return { ...base, traits: slim };
  }
  if (includeTraits) return base;
  return {
    id: account.id,
    name: account.name,
    externalId: account.externalId,
    uri: `vitally://account/${account.id}`,
  };
}

/** Strip the embedded `account` object from a row but preserve `accountId`. */
function stripAccountField<T extends { account?: VitallyAccount; accountId?: string }>(
  row: T,
  includeAccount: boolean
): Record<string, unknown> {
  if (includeAccount) return row as Record<string, unknown>;
  const { account, ...rest } = row as Record<string, unknown> & { account?: VitallyAccount };
  const accountId =
    (rest as { accountId?: string }).accountId ??
    (account && typeof account === "object" ? (account as VitallyAccount).id : undefined);
  if (accountId !== undefined) (rest as Record<string, unknown>).accountId = accountId;
  return rest;
}

// ---------------------------------------------------------------------------
// HTML stripping for task descriptions / note bodies
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function decodeEntities(s: string): string {
  let out = s.replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, m => HTML_ENTITIES[m] ?? m);
  out = out.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
  return out;
}

function htmlToPlain(html: string): string {
  if (!html) return html;
  let out = html;
  // Replace <img ...> with [image] placeholder before stripping tags.
  out = out.replace(/<img\b[^>]*\/?>/gi, "[image]");
  // Block-level boundaries → newline.
  out = out.replace(/<\s*br\s*\/?>/gi, "\n");
  out = out.replace(/<\/\s*(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, "\n");
  out = out.replace(/<\s*li[^>]*>/gi, "- ");
  // Strip remaining tags.
  out = out.replace(/<[^>]+>/g, "");
  // Decode entities.
  out = decodeEntities(out);
  // Collapse whitespace runs but preserve paragraph breaks.
  out = out.replace(/\r\n/g, "\n");
  out = out.replace(/[ \t]+\n/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

function transformTaskDescription(task: VitallyTask, format: "plain" | "html"): VitallyTask {
  if (format === "html" || !task.description) return task;
  return { ...task, description: htmlToPlain(task.description) };
}

function transformNoteContent(note: VitallyNote, format: "plain" | "html"): VitallyNote {
  if (format === "html") return note;
  const out: VitallyNote = { ...note };
  if (out.content) out.content = htmlToPlain(out.content);
  if (out.note) out.note = htmlToPlain(out.note);
  return out;
}

// ---------------------------------------------------------------------------
// Mock data for demo mode
// ---------------------------------------------------------------------------

const MOCK_ACCOUNTS: VitallyAccount[] = [
  {
    id: "1",
    name: "Acme Corporation",
    externalId: "acme-corp",
    traits: {
      "vitally.custom.arr": 120000,
      "vitally.custom.arrTier": "Tier 1",
      "vitally.custom.csmSentiment": "positive",
      "vitally.custom.testAccount": false,
    },
    mrr: 10000,
    nextRenewalDate: "2026-12-01",
    usersCount: 42,
    npsScore: 9,
    healthScore: 88,
    csmId: "csm-1",
    accountExecutiveId: "ae-1",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2026-04-01T10:00:00Z",
  },
  {
    id: "2",
    name: "Globex Industries",
    externalId: "globex",
    traits: {
      "vitally.custom.arr": 60000,
      "vitally.custom.arrTier": "Tier 2",
      "vitally.custom.csmSentiment": "neutral",
      "vitally.custom.testAccount": false,
    },
    mrr: 5000,
    nextRenewalDate: "2026-09-15",
    usersCount: 18,
    npsScore: 7,
    healthScore: 72,
    csmId: "csm-2",
    createdAt: "2024-03-20T10:00:00Z",
    updatedAt: "2026-04-01T10:00:00Z",
  },
  {
    id: "3",
    name: "Initech Technologies",
    externalId: "initech",
    traits: {
      "vitally.custom.arr": 24000,
      "vitally.custom.arrTier": "Tier 3",
      "vitally.custom.csmSentiment": "neutral",
      "vitally.custom.testAccount": false,
    },
    mrr: 2000,
    nextRenewalDate: "2026-07-20",
    usersCount: 7,
    npsScore: 5,
    healthScore: 60,
    createdAt: "2025-02-12T10:00:00Z",
    updatedAt: "2026-04-01T10:00:00Z",
  },
  {
    id: "4",
    name: "Sace",
    externalId: "sace",
    traits: {
      "vitally.custom.arr": 7000,
      "vitally.custom.arrTier": "Tier 3",
      "vitally.custom.csmSentiment": "positive",
      "vitally.custom.testAccount": false,
    },
    mrr: 583.33,
    nextRenewalDate: "2027-01-10",
    usersCount: 4,
    npsScore: 8,
    healthScore: 80,
    createdAt: "2025-05-01T10:00:00Z",
    updatedAt: "2026-04-01T10:00:00Z",
  },
  {
    id: "5",
    name: "Stark Industries",
    externalId: "stark",
    traits: {
      "vitally.custom.arr": 250000,
      "vitally.custom.arrTier": "Tier 1",
      "vitally.custom.csmSentiment": "positive",
      "vitally.custom.testAccount": false,
    },
    mrr: 20833.33,
    nextRenewalDate: "2026-11-05",
    usersCount: 120,
    npsScore: 10,
    healthScore: 95,
    csmId: "csm-1",
    createdAt: "2023-08-01T10:00:00Z",
    updatedAt: "2026-04-01T10:00:00Z",
  },
];

const MOCK_USERS: VitallyUser[] = [
  { id: "101", name: "John Doe", email: "john@acme-corp.com", externalId: "user-101", accountId: "1", account: MOCK_ACCOUNTS[0] },
  { id: "102", name: "Jane Smith", email: "jane@globex.com", externalId: "user-102", accountId: "2", account: MOCK_ACCOUNTS[1] },
  { id: "103", name: "Mike Johnson", email: "mike@initech.com", externalId: "user-103", accountId: "3", account: MOCK_ACCOUNTS[2] },
];

const MOCK_TASKS: VitallyTask[] = [
  {
    id: "t1",
    title: "Follow-up Call",
    description: "<p>Schedule follow-up for new feature.</p><p>See <img src=\"data:image/png;base64,xxx\"/> attached.</p>",
    status: "open",
    completedAt: null,
    archivedAt: null,
    accountId: "4",
    account: MOCK_ACCOUNTS[3],
    createdAt: "2026-03-10T14:20:00Z",
    updatedAt: "2026-03-10T14:20:00Z",
  },
  {
    id: "t2",
    title: "Renewal Discussion",
    description: "<p>Discuss upcoming renewal.</p>",
    status: "completed",
    completedAt: "2026-02-28T16:45:00Z",
    archivedAt: null,
    accountId: "4",
    account: MOCK_ACCOUNTS[3],
    createdAt: "2026-02-05T11:00:00Z",
    updatedAt: "2026-02-28T16:45:00Z",
  },
  {
    id: "t3",
    title: "Cancelled Onboarding",
    description: "<p>No longer needed.</p>",
    status: "archived",
    completedAt: null,
    archivedAt: "2026-01-20T08:00:00Z",
    accountId: "4",
    account: MOCK_ACCOUNTS[3],
    createdAt: "2026-01-10T08:00:00Z",
    updatedAt: "2026-01-20T08:00:00Z",
  },
  {
    id: "t4",
    title: "Open follow-up",
    description: "<p>Another open one.</p>",
    status: "open",
    completedAt: null,
    archivedAt: null,
    accountId: "4",
    account: MOCK_ACCOUNTS[3],
    createdAt: "2026-04-01T10:00:00Z",
    updatedAt: "2026-04-01T10:00:00Z",
  },
];

const MOCK_NOTES: VitallyNote[] = [
  {
    id: "n1",
    content: "<p>Initial onboarding kickoff.</p><p>Stakeholders: <strong>CTO</strong>, <strong>VP Eng</strong>.</p>",
    accountId: "1",
    account: MOCK_ACCOUNTS[0],
    createdAt: "2026-01-10T12:00:00Z",
    updatedAt: "2026-01-10T12:00:00Z",
  },
  {
    id: "n2",
    content: "<p>QBR notes.</p>",
    accountId: "2",
    account: MOCK_ACCOUNTS[1],
    createdAt: "2026-04-02T09:30:00Z",
    updatedAt: "2026-04-02T09:30:00Z",
  },
];

const MOCK_ADMINS = [
  { id: "adm-1", name: "Andrea Rossi", email: "andrea@wiseair.example", licenseStatus: "active" },
  { id: "adm-2", name: "Paola Bianchi", email: "paola@wiseair.example", licenseStatus: "active" },
];

// Mirrors the real workspace: two Custom Object schemas, contract + proposal.
const MOCK_CUSTOM_OBJECTS = [
  {
    id: "co-1",
    name: "subscription",
    label: "Subscription",
    syncActive: true,
    writeMode: "writable",
    customFields: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
  },
  {
    id: "co-2",
    name: "contract",
    label: "Contract",
    syncActive: true,
    writeMode: "writable",
    customFields: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
  },
  {
    id: "co-3",
    name: "proposal",
    label: "Proposal",
    syncActive: true,
    writeMode: "writable",
    customFields: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
  },
];

// Instance rows carry the same shape as the real API: embedded `customer`
// (full account) + `customers` array, traits, archivedAt.
const MOCK_CO_INSTANCES: Record<string, Record<string, unknown>[]> = {
  "co-2": [
    {
      id: "coi-c1",
      name: "Acme 2026 renewal",
      externalId: null,
      customObjectId: "co-2",
      customerId: "1",
      organizationId: null,
      customer: MOCK_ACCOUNTS[0],
      customers: [MOCK_ACCOUNTS[0]],
      archivedAt: null,
      traits: { "vitally.custom.contractArr": 120000, "vitally.custom.renewalStage": "Negotiation" },
      createdAt: "2026-01-05T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    },
    {
      id: "coi-c2",
      name: "Sace 2027 contract",
      externalId: null,
      customObjectId: "co-2",
      customerId: "4",
      organizationId: null,
      customer: MOCK_ACCOUNTS[3],
      customers: [MOCK_ACCOUNTS[3]],
      archivedAt: null,
      traits: { "vitally.custom.contractArr": 7000, "vitally.custom.renewalStage": "Closed Won" },
      createdAt: "2026-02-10T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
    },
  ],
  "co-3": [
    {
      id: "coi-p1",
      name: "Sace - Rinnovo con nuovo pricing",
      externalId: null,
      customObjectId: "co-3",
      customerId: "4",
      organizationId: null,
      customer: MOCK_ACCOUNTS[3],
      customers: [MOCK_ACCOUNTS[3]],
      archivedAt: null,
      traits: {
        "vitally.custom.upsellArr": 2000,
        "vitally.custom.renewalStage": "Proposal sent",
        "vitally.custom.upsellStage": "Discovery",
        "vitally.custom.primaryProposedArr": 9000,
      },
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-06-20T00:00:00Z",
    },
  ],
};

const MOCK_MEETINGS: Record<string, unknown>[] = [
  {
    id: "m1",
    subject: "Acme QBR",
    date: "2026-06-15T10:00:00Z",
    durationInMinutes: 45,
    accountId: "1",
    account: MOCK_ACCOUNTS[0],
    participants: [{ name: "John Doe", email: "john@acme-corp.com" }],
    createdAt: "2026-06-15T11:00:00Z",
    updatedAt: "2026-06-15T11:00:00Z",
  },
  {
    id: "m2",
    subject: "Sace onboarding kickoff",
    date: "2026-06-20T14:00:00Z",
    durationInMinutes: 30,
    accountId: "4",
    account: MOCK_ACCOUNTS[3],
    participants: [],
    createdAt: "2026-06-20T15:00:00Z",
    updatedAt: "2026-06-20T15:00:00Z",
  },
];

const MOCK_MEETING_TRANSCRIPTS: Record<string, unknown> = {
  m1: { meetingId: "m1", transcript: "Speaker 1: Welcome to the QBR...", createdAt: "2026-06-15T11:05:00Z" },
};

const MOCK_NPS_RESPONSES: Record<string, unknown>[] = [
  { id: "nps-1", userId: "101", accountId: "1", account: MOCK_ACCOUNTS[0], score: 9, feedback: "Great product", respondedAt: "2026-05-01T09:00:00Z" },
  { id: "nps-2", userId: "103", accountId: "3", account: MOCK_ACCOUNTS[2], score: 5, feedback: "Setup was hard", respondedAt: "2026-05-10T09:00:00Z" },
];

const MOCK_SURVEY_RESPONSES: Record<string, unknown>[] = [
  {
    id: "sr-1",
    surveyId: "survey-1",
    userId: "101",
    respondedAt: "2026-06-01T08:00:00Z",
    questionResponses: [
      { id: "qr-1", questionId: "q-1", data: { type: "rating", value: 4 } },
      { id: "qr-2", questionId: "q-2", data: { type: "text", value: "More dashboards please" } },
    ],
  },
];

function applyNullScores(acc: VitallyAccount): VitallyAccount {
  if (!DEMO_NULL_SCORES) return acc;
  return { ...acc, healthScore: null, npsScore: null };
}

function mockApiResponse<T>(endpoint: string, method = "GET", body?: unknown): T {
  log(`DEMO MODE: ${method} ${endpoint}`);

  const [pathOnly, qs = ""] = endpoint.split("?");
  const params = new URLSearchParams(qs);

  const accountByIdMatch = pathOnly.match(/^\/resources\/accounts\/([^/]+)$/);
  if (accountByIdMatch && method === "GET") {
    const idOrExt = decodeURIComponent(accountByIdMatch[1]);
    const acc = MOCK_ACCOUNTS.find(a => a.id === idOrExt || a.externalId === idOrExt);
    if (!acc) throw new Error(`Vitally API 404 Not Found on GET ${endpoint}: account not found`);
    return applyNullScores(acc) as unknown as T;
  }

  if (accountByIdMatch && method === "PUT") {
    const idOrExt = decodeURIComponent(accountByIdMatch[1]);
    const idx = MOCK_ACCOUNTS.findIndex(a => a.id === idOrExt || a.externalId === idOrExt);
    if (idx === -1) throw new Error(`Vitally API 404 Not Found on PUT ${endpoint}: account not found`);
    const patch = (body || {}) as Partial<VitallyAccount>;
    const merged: VitallyAccount = {
      ...MOCK_ACCOUNTS[idx],
      ...patch,
      traits: { ...(MOCK_ACCOUNTS[idx].traits || {}), ...(patch.traits || {}) },
    };
    MOCK_ACCOUNTS[idx] = merged;
    return merged as unknown as T;
  }

  if (pathOnly === "/resources/accounts" && method === "GET") {
    const limit = parseInt(params.get("limit") || "100", 10);
    // Demo cursor is a plain numeric offset (real API uses an opaque token).
    const from = parseInt(params.get("from") || "0", 10);
    const slice = MOCK_ACCOUNTS.slice(from, from + limit);
    return {
      results: slice.map(applyNullScores),
      next: from + limit < MOCK_ACCOUNTS.length ? String(from + limit) : null,
    } as unknown as T;
  }

  if (pathOnly.match(/^\/resources\/accounts\/[^/]+\/healthScores$/)) {
    const accountId = pathOnly.split("/")[3];
    return {
      overallHealth: 85,
      components: [
        { name: "Product Usage", score: 90 },
        { name: "Support Tickets", score: 75 },
        { name: "Billing Status", score: 95 },
      ],
      accountId,
    } as unknown as T;
  }

  if (pathOnly.match(/^\/resources\/accounts\/[^/]+\/conversations$/)) {
    const accountId = pathOnly.split("/")[3];
    const acc = MOCK_ACCOUNTS.find(a => a.id === accountId || a.externalId === accountId);
    return {
      results: [
        { id: "c1", subject: "Product Feedback", accountId: acc?.id, account: acc, createdAt: "2026-01-15T10:30:00Z", updatedAt: "2026-01-16T15:45:00Z" },
        { id: "c2", subject: "Support Question", accountId: acc?.id, account: acc, createdAt: "2026-02-22T09:15:00Z", updatedAt: "2026-02-23T11:30:00Z" },
      ],
      next: null,
    } as unknown as T;
  }

  if (pathOnly.match(/^\/resources\/accounts\/[^/]+\/tasks$/)) {
    const accountId = pathOnly.split("/")[3];
    const tasks = MOCK_TASKS.filter(t => {
      const acc = MOCK_ACCOUNTS.find(a => a.id === accountId || a.externalId === accountId);
      return t.accountId === acc?.id;
    });
    return { results: tasks, next: null } as unknown as T;
  }

  if (pathOnly === "/resources/notes" && method === "POST") {
    const noteBody = (body || {}) as {
      accountId?: string;
      organizationId?: string;
      note?: string;
      noteDate?: string;
      subject?: string;
      authorId?: string;
      categoryId?: string;
      externalId?: string;
      tags?: string[];
      traits?: Record<string, unknown>;
    };
    const now = new Date().toISOString();
    return {
      id: "n-mock-" + Date.now(),
      note: noteBody.note,
      noteDate: noteBody.noteDate ?? now,
      accountId: noteBody.accountId,
      organizationId: noteBody.organizationId,
      subject: noteBody.subject,
      authorId: noteBody.authorId,
      categoryId: noteBody.categoryId,
      externalId: noteBody.externalId,
      tags: noteBody.tags,
      traits: noteBody.traits,
      createdAt: now,
      updatedAt: now,
    } as unknown as T;
  }

  if (pathOnly.match(/^\/resources\/accounts\/[^/]+\/notes$/)) {
    const accountId = pathOnly.split("/")[3];
    const acc = MOCK_ACCOUNTS.find(a => a.id === accountId || a.externalId === accountId);
    const notes = MOCK_NOTES.filter(n => n.accountId === acc?.id);
    return { results: notes, next: null } as unknown as T;
  }

  if (pathOnly === "/resources/notes" && method === "GET") {
    return { results: MOCK_NOTES, next: null } as unknown as T;
  }

  if (pathOnly.match(/^\/resources\/notes\/[^/]+$/)) {
    const id = pathOnly.split("/")[3];
    const found = MOCK_NOTES.find(n => n.id === id);
    if (found) return found as unknown as T;
    return {
      id,
      content: "<p>Mock note body for " + id + "</p>",
      accountId: "1",
      account: MOCK_ACCOUNTS[0],
      createdAt: "2026-01-10T12:00:00Z",
      updatedAt: "2026-01-10T12:00:00Z",
    } as unknown as T;
  }

  if (pathOnly === "/resources/tasks" && method === "GET") {
    return { results: MOCK_TASKS, next: null } as unknown as T;
  }

  if (pathOnly === "/resources/tasks" && method === "POST") {
    const taskBody = (body || {}) as {
      name?: string;
      accountId?: string;
      organizationId?: string;
      description?: string;
      assignedToId?: string;
      dueDate?: string;
    };
    const now = new Date().toISOString();
    return {
      id: "t-mock-" + Date.now(),
      title: taskBody.name,
      description: taskBody.description,
      accountId: taskBody.accountId,
      dueDate: taskBody.dueDate,
      assignedToId: taskBody.assignedToId,
      organizationId: taskBody.organizationId,
      completedAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    } as unknown as T;
  }

  const taskByIdMatch = pathOnly.match(/^\/resources\/tasks\/([^/]+)$/);
  if (taskByIdMatch && method === "PUT") {
    const id = decodeURIComponent(taskByIdMatch[1]);
    const idx = MOCK_TASKS.findIndex(t => t.id === id || t.externalId === id);
    if (idx === -1) throw new Error(`Vitally API 404 Not Found on PUT ${endpoint}: task not found`);
    const patch = { ...((body || {}) as Record<string, unknown>) };
    if (typeof patch.name === "string") {
      patch.title = patch.name;
      delete patch.name;
    }
    const merged: VitallyTask = { ...MOCK_TASKS[idx], ...patch, updatedAt: new Date().toISOString() };
    MOCK_TASKS[idx] = merged;
    return merged as unknown as T;
  }

  if (pathOnly === "/resources/conversations" && method === "GET") {
    return {
      results: [
        { id: "c1", subject: "Product Feedback", accountId: "1", account: MOCK_ACCOUNTS[0], createdAt: "2026-01-15T10:30:00Z", updatedAt: "2026-01-16T15:45:00Z" },
      ],
      next: null,
    } as unknown as T;
  }

  if (pathOnly === "/resources/projects" && method === "GET") {
    return {
      results: [
        { id: "p1", name: "Acme Onboarding", status: "active", account: MOCK_ACCOUNTS[0], createdAt: "2026-01-05T10:00:00Z", updatedAt: "2026-02-01T10:00:00Z" },
      ],
      next: null,
    } as unknown as T;
  }

  if (pathOnly.match(/^\/resources\/projects\/[^/]+$/) && method === "GET") {
    const id = pathOnly.split("/")[3];
    return { id, name: "Mock Project " + id, status: "active", account: MOCK_ACCOUNTS[0], createdAt: "2026-01-05T10:00:00Z", updatedAt: "2026-02-01T10:00:00Z" } as unknown as T;
  }

  if (pathOnly === "/resources/organizations" && method === "GET") {
    return {
      results: [
        { id: "org-1", name: "Acme Holdings", externalId: "acme-holdings" },
      ],
      next: null,
    } as unknown as T;
  }

  if (pathOnly === "/resources/customFields" && method === "GET") {
    const model = params.get("model") || "accounts";
    return [
      { label: "ARR", type: "number", path: "vitally.custom.arr", createdAt: "2026-01-01T00:00:00Z" },
      { label: "ARR Tier", type: "string", path: "vitally.custom.arrTier", createdAt: "2026-01-01T00:00:00Z", options: ["Tier 1", "Tier 2", "Tier 3"] },
      { label: "CSM Sentiment", type: "string", path: "vitally.custom.csmSentiment", createdAt: "2026-01-01T00:00:00Z", options: ["positive", "neutral", "negative"] },
      { label: "Test Account", type: "boolean", path: "vitally.custom.testAccount", createdAt: "2026-01-01T00:00:00Z" },
      { label: `Mock field for ${model}`, type: "string", path: `vitally.custom.mock_${model}`, createdAt: "2026-01-01T00:00:00Z" },
    ] as unknown as T;
  }

  if (pathOnly === "/resources/customObjects" && method === "GET") {
    return { results: MOCK_CUSTOM_OBJECTS, next: null } as unknown as T;
  }

  // Search returns a BARE ARRAY (no {results, next} envelope) — same as the
  // real API. Keep the mock faithful so the normalization path is exercised.
  const instancesSearchMatch = pathOnly.match(/^\/resources\/customObjects\/([^/]+)\/instances\/search$/);
  if (instancesSearchMatch && method === "GET") {
    const coId = decodeURIComponent(instancesSearchMatch[1]);
    const customerId = params.get("customerId");
    let rows = MOCK_CO_INSTANCES[coId] ?? [];
    if (customerId) rows = rows.filter(r => r.customerId === customerId);
    return rows as unknown as T;
  }

  const instancesMatch = pathOnly.match(/^\/resources\/customObjects\/([^/]+)\/instances$/);
  if (instancesMatch && method === "GET") {
    const coId = decodeURIComponent(instancesMatch[1]);
    return { results: MOCK_CO_INSTANCES[coId] ?? [], next: null } as unknown as T;
  }

  const meetingTranscriptMatch = pathOnly.match(/^\/resources\/meetings\/([^/]+)\/transcript$/);
  if (meetingTranscriptMatch && method === "GET") {
    const meetingId = decodeURIComponent(meetingTranscriptMatch[1]);
    const transcript = MOCK_MEETING_TRANSCRIPTS[meetingId];
    if (!transcript) throw new Error(`Vitally API 404 Not Found on GET ${endpoint}: no transcript`);
    return transcript as unknown as T;
  }

  const meetingByIdMatch = pathOnly.match(/^\/resources\/meetings\/([^/]+)$/);
  if (meetingByIdMatch && method === "GET") {
    const meetingId = decodeURIComponent(meetingByIdMatch[1]);
    const meeting = MOCK_MEETINGS.find(m => m.id === meetingId);
    if (!meeting) throw new Error(`Vitally API 404 Not Found on GET ${endpoint}: meeting not found`);
    return meeting as unknown as T;
  }

  const accountMeetingsMatch = pathOnly.match(/^\/resources\/accounts\/([^/]+)\/meetings$/);
  if (accountMeetingsMatch && method === "GET") {
    const accountId = decodeURIComponent(accountMeetingsMatch[1]);
    const acc = MOCK_ACCOUNTS.find(a => a.id === accountId || a.externalId === accountId);
    return { results: MOCK_MEETINGS.filter(m => m.accountId === acc?.id), next: null } as unknown as T;
  }

  if (pathOnly === "/resources/meetings" && method === "GET") {
    return { results: MOCK_MEETINGS, next: null } as unknown as T;
  }

  const accountNpsMatch = pathOnly.match(/^\/resources\/accounts\/([^/]+)\/npsResponses$/);
  if (accountNpsMatch && method === "GET") {
    const accountId = decodeURIComponent(accountNpsMatch[1]);
    const acc = MOCK_ACCOUNTS.find(a => a.id === accountId || a.externalId === accountId);
    return { results: MOCK_NPS_RESPONSES.filter(r => r.accountId === acc?.id), next: null } as unknown as T;
  }

  if (pathOnly === "/resources/npsResponses" && method === "GET") {
    return { results: MOCK_NPS_RESPONSES, next: null } as unknown as T;
  }

  const surveyResponsesMatch = pathOnly.match(/^\/resources\/surveys\/([^/]+)\/responses$/);
  if (surveyResponsesMatch && method === "GET") {
    const surveyId = decodeURIComponent(surveyResponsesMatch[1]);
    return {
      results: MOCK_SURVEY_RESPONSES.filter(r => r.surveyId === surveyId),
      next: null,
    } as unknown as T;
  }

  const surveyResponseByIdMatch = pathOnly.match(/^\/resources\/surveyResponses\/([^/]+)$/);
  if (surveyResponseByIdMatch && method === "GET") {
    const responseId = decodeURIComponent(surveyResponseByIdMatch[1]);
    const found = MOCK_SURVEY_RESPONSES.find(r => r.id === responseId);
    if (!found) throw new Error(`Vitally API 404 Not Found on GET ${endpoint}: survey response not found`);
    return found as unknown as T;
  }

  if (pathOnly === "/resources/admins" && method === "GET") {
    return { results: MOCK_ADMINS, next: null } as unknown as T;
  }

  if (pathOnly === "/resources/taskCategories" && method === "GET") {
    return {
      results: [
        { id: "tc-1", name: "Onboarding", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        { id: "tc-2", name: "Renewal", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        { id: "tc-3", name: "Support", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      ],
      next: null,
    } as unknown as T;
  }

  if (pathOnly === "/resources/noteCategories" && method === "GET") {
    return {
      results: [
        { id: "nc-1", name: "QBR", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        { id: "nc-2", name: "Check-in", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        { id: "nc-3", name: "Escalation", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      ],
      next: null,
    } as unknown as T;
  }

  if (pathOnly.match(/^\/resources\/users\/[^/]+$/) && method === "GET" && pathOnly !== "/resources/users/search") {
    const id = pathOnly.split("/")[3];
    const user = MOCK_USERS.find(u => u.id === id || u.externalId === id);
    if (!user) throw new Error(`Vitally API 404 Not Found on GET ${endpoint}: user not found`);
    return user as unknown as T;
  }

  if (pathOnly === "/resources/users/search" || pathOnly === "/resources/users") {
    return { results: MOCK_USERS, next: null } as unknown as T;
  }

  return {} as T;
}

// ---------------------------------------------------------------------------
// In-memory caches & session-level flags
// ---------------------------------------------------------------------------

let accountsCache: VitallyAccount[] = [];
let accountsCacheComplete = false;
let accountsCacheLoadedAt: string | null = null;
let accountsCachePages = 0;

// Vitally caps page size at 100. Env override exists only so demo-mode tests
// can exercise the multi-page loop against the small mock fixture set.
const ACCOUNTS_PAGE_SIZE = Math.max(
  1,
  Math.min(100, parseInt(process.env.VITALLY_ACCOUNTS_PAGE_SIZE || "100", 10) || 100)
);
// Hard stop for the sync loop (50 pages × 100 = 5,000 accounts) so a cursor
// that never goes null cannot spin forever. If the cap is hit the cache is
// kept but flagged incomplete.
const ACCOUNTS_PAGE_CAP = 50;

async function ensureAccountsLoaded(force = false): Promise<void> {
  if (!force && accountsCache.length > 0) return;
  const collected: VitallyAccount[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let complete = false;
  while (pages < ACCOUNTS_PAGE_CAP) {
    pages += 1;
    const page = await callVitallyAPI<VitallyPaginatedResponse<VitallyAccount>>(
      // status=activeOrChurned: without it Vitally defaults to active-only,
      // silently dropping churned accounts from every cache-backed tool.
      `/resources/accounts${buildQuery({ limit: ACCOUNTS_PAGE_SIZE, from: cursor, status: "activeOrChurned" })}`
    );
    const results = page.results || [];
    collected.push(...results);
    if (!page.next || results.length === 0) {
      complete = true;
      break;
    }
    cursor = page.next;
  }
  accountsCache = collected;
  accountsCacheComplete = complete;
  accountsCacheLoadedAt = new Date().toISOString();
  accountsCachePages = pages;
}

// Workspace-level data hygiene flags. Sample once per server lifetime; emit
// each warning string at most once per session.
const HEALTH_SAMPLE_SIZE = 20;
let healthSampleDone = false;
let workspaceWarnings: string[] = [];
const seenWarnings = new Set<string>();

async function ensureHealthSample(): Promise<void> {
  if (healthSampleDone) return;
  healthSampleDone = true;
  try {
    await ensureAccountsLoaded();
  } catch {
    return;
  }
  const sample = accountsCache.slice(0, HEALTH_SAMPLE_SIZE);
  if (sample.length === 0) return;
  const allHealthNull = sample.every(a => a.healthScore === null || a.healthScore === undefined);
  const allNpsNull = sample.every(a => a.npsScore === null || a.npsScore === undefined);
  if (allHealthNull) {
    workspaceWarnings.push(
      "healthScore is null on all sampled accounts — workspace likely has no health score configured"
    );
  }
  if (allNpsNull) {
    workspaceWarnings.push(
      "npsScore is null on all sampled accounts — likely no NPS data flowing in"
    );
  }
}

function consumeWarnings(): string[] | undefined {
  if (workspaceWarnings.length === 0) return undefined;
  const fresh = workspaceWarnings.filter(w => !seenWarnings.has(w));
  for (const w of fresh) seenWarnings.add(w);
  return fresh.length > 0 ? fresh : undefined;
}

function attachWarnings<T extends Record<string, unknown>>(payload: T): T {
  const warnings = consumeWarnings();
  if (warnings) (payload as Record<string, unknown>)._warnings = warnings;
  return payload;
}

// ---------------------------------------------------------------------------
// Sort / filter helpers (used by list_accounts and aggregate_accounts)
// ---------------------------------------------------------------------------

const TOP_LEVEL_SORT_FIELDS = new Set([
  "mrr",
  "usersCount",
  "nextRenewalDate",
  "createdAt",
  "updatedAt",
  "healthScore",
  "npsScore",
  "name",
]);

function getFieldValue(account: VitallyAccount, field: string): unknown {
  if (TOP_LEVEL_SORT_FIELDS.has(field) || field in account) {
    return (account as Record<string, unknown>)[field];
  }
  // Treat as trait key.
  return (account.traits || {})[field];
}

function isNullish(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

function compareValues(a: unknown, b: unknown, order: "asc" | "desc"): number {
  const an = isNullish(a);
  const bn = isNullish(b);
  if (an && bn) return 0;
  if (an) return 1; // null always last regardless of order
  if (bn) return -1;
  let cmp = 0;
  if (typeof a === "number" && typeof b === "number") {
    cmp = a - b;
  } else {
    const as = String(a);
    const bs = String(b);
    cmp = as < bs ? -1 : as > bs ? 1 : 0;
  }
  return order === "desc" ? -cmp : cmp;
}

function matchesFilterTraits(account: VitallyAccount, filter: Record<string, unknown>): boolean {
  const traits = account.traits || {};
  for (const [key, value] of Object.entries(filter)) {
    if (traits[key] !== value) return false;
  }
  return true;
}

function isAccountActive(account: VitallyAccount, status: "active" | "churned" | "activeOrChurned"): boolean {
  if (status === "activeOrChurned") return true;
  const churned = !!account.churnedAt;
  if (status === "active") return !churned;
  if (status === "churned") return churned;
  return true;
}

// ---------------------------------------------------------------------------
// Multi-page accumulation for client-side filtering (used by get_account_tasks)
// ---------------------------------------------------------------------------

const TASK_STATUS_PAGE_CAP = 5;

function taskMatchesStatus(task: VitallyTask, status: "open" | "completed" | "archived"): boolean {
  if (status === "completed") return !!task.completedAt;
  if (status === "archived") return !!task.archivedAt;
  // open
  return !task.completedAt && !task.archivedAt;
}

interface FilteredTasksResult {
  results: VitallyTask[];
  next: string | null;
  pagesScanned: number;
  truncated: boolean;
}

async function fetchTasksWithStatusFilter(
  endpoint: string,
  baseParams: Record<string, string | number | boolean | undefined | null>,
  status: "open" | "completed" | "archived" | undefined,
  limit: number
): Promise<FilteredTasksResult> {
  const collected: VitallyTask[] = [];
  let cursor: string | undefined = baseParams.from as string | undefined;
  let pages = 0;
  let lastNext: string | null = null;
  while (pages < TASK_STATUS_PAGE_CAP && collected.length < limit) {
    pages += 1;
    const page = await paginate<VitallyTask>(endpoint, { ...baseParams, limit, from: cursor });
    lastNext = page.next;
    for (const task of page.results) {
      if (!status || taskMatchesStatus(task, status)) {
        collected.push(task);
        if (collected.length >= limit) break;
      }
    }
    if (!page.next) {
      lastNext = null;
      break;
    }
    cursor = page.next;
  }
  return {
    results: collected.slice(0, limit),
    next: lastNext,
    pagesScanned: pages,
    truncated: pages >= TASK_STATUS_PAGE_CAP && collected.length < limit && lastNext !== null,
  };
}

// ---------------------------------------------------------------------------
// Guarded traits — values that flow in from system-of-record sources and
// should never be overwritten by an LLM without an explicit force flag.
// ---------------------------------------------------------------------------

const GUARDED_TRAITS = new Set<string>([
  "vitally.custom.arr",
  "vitally.custom.mrr",
  "vitally.custom.status",
  "vitally.custom.churnDate",
  "vitally.custom.nextRenewal",
  "vitally.custom.currentSubscriptionStartDate",
  "vitally.custom.testAccount",
]);

function findGuardedTraitWrites(traits: Record<string, unknown> | undefined): string[] {
  if (!traits) return [];
  return Object.keys(traits).filter(k => GUARDED_TRAITS.has(k));
}

// ---------------------------------------------------------------------------
// Custom Object record helpers
// ---------------------------------------------------------------------------

interface CustomObjectSchema {
  id: string;
  name?: string;
  label?: string;
  [key: string]: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Schemas change rarely; one fetch per server lifetime is enough. The mock
// "co-*" ids are not UUIDs, so demo mode always goes through the name path —
// resolveCustomObject therefore also accepts raw ids returned by the list.
let customObjectSchemasCache: CustomObjectSchema[] | null = null;

async function resolveCustomObject(ref: string): Promise<CustomObjectSchema> {
  if (UUID_RE.test(ref)) return { id: ref };
  if (!customObjectSchemasCache) {
    const page = await callVitallyAPI<VitallyPaginatedResponse<CustomObjectSchema>>(
      "/resources/customObjects?limit=100"
    );
    customObjectSchemasCache = page.results || [];
  }
  const needle = ref.toLowerCase();
  const hit = customObjectSchemasCache.find(
    s =>
      s.id === ref ||
      String(s.name ?? "").toLowerCase() === needle ||
      String(s.label ?? "").toLowerCase() === needle
  );
  if (!hit) {
    const known = customObjectSchemasCache.map(s => s.name ?? s.label ?? s.id).join(", ");
    throw new Error(`Custom Object "${ref}" not found. Known objects: ${known || "(none)"}`);
  }
  return hit;
}

/**
 * Instance rows embed the FULL parent account twice (`customer` object +
 * `customers` array) — strip both by default, preserve customerId.
 */
function stripInstanceCustomer(row: Record<string, unknown>, includeCustomer: boolean): Record<string, unknown> {
  if (includeCustomer) return row;
  const { customer, customers, ...rest } = row as Record<string, unknown> & {
    customer?: VitallyAccount;
    customers?: VitallyAccount[];
  };
  if (rest.customerId === undefined && customer && typeof customer === "object") {
    rest.customerId = (customer as VitallyAccount).id;
  }
  return rest;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

const TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "search_tools",
    description: "Search for available Vitally MCP tools by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Keyword to search in tool names and descriptions." },
      },
      required: ["keyword"],
    },
  },
  {
    name: "search_users",
    description: "Search for users by email, externalId, or email subdomain.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "User email address." },
        externalId: { type: "string", description: "External user ID." },
        emailSubdomain: { type: "string", description: "Email subdomain to search for." },
      },
    },
  },
  {
    name: "get_user",
    description: "Get the full Vitally user object by Vitally ID or externalId.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "Vitally user ID or externalId." },
      },
      required: ["userId"],
    },
  },
  {
    name: "search_accounts",
    description:
      "Search accounts by name and/or externalId over the fully-synced cache (entire Vitally base, active + churned). Returns the full account payload by default. Use `traits` to project only specific trait keys, or `includeTraits=false` for a slim shape. Response reports count vs totalMatches vs totalAccounts; `partial: true` means more matches exist than were returned — raise `limit`.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full or partial account name (case insensitive)." },
        externalId: { type: "string", description: "Exact externalId match." },
        limit: { type: "number", description: "Maximum number of results (default: 10)." },
        includeTraits: {
          type: "boolean",
          description: "Set to false to return a slim {id,name,externalId,uri} shape. Default true. Mutually exclusive with `traits` (if both passed, `traits` wins and a warning is surfaced).",
        },
        traits: {
          type: "array",
          items: { type: "string" },
          description: "If provided, return only these trait keys per row (others omitted). Implies includeTraits=true.",
        },
      },
    },
  },
  {
    name: "find_account_by_name",
    description:
      "DEPRECATED — use `search_accounts` instead. This tool now forwards to search_accounts. Find accounts by name (partial, case insensitive). Returns the full account payload.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full or partial account name." },
        includeTraits: {
          type: "boolean",
          description: "Set to false to return a slim {id,name,externalId,uri} shape. Default true.",
        },
        traits: {
          type: "array",
          items: { type: "string" },
          description: "If provided, return only these trait keys per row.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "get_account",
    description:
      "Get the full Vitally account object by Vitally ID or externalId. Includes traits, MRR, nextRenewalDate, usersCount, npsScore, healthScore, csmId, accountExecutiveId, and all other fields. Workspace-level _warnings (e.g. health/NPS not configured) may be attached.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Vitally account UUID." },
        externalId: { type: "string", description: "External account ID. Either accountId or externalId is required." },
      },
    },
  },
  {
    name: "list_accounts",
    description:
      "Paginated list of accounts. By default proxies GET /resources/accounts with cursor pagination (`partial: true` + non-null `next` mean more pages exist — pass `next` as `from`). When `sortBy`, `filterTraits`, or `traits` projection is provided, the call is served from the fully-synced in-memory cache and reports count vs totalMatches vs totalAccounts. `traits` projects only specific trait keys per row; `includeTraits=false` returns a slim shape.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Page size, max 100, default 50." },
        from: { type: "string", description: "Cursor token from the previous response's `next` field. Ignored in cache-mode (sortBy/filterTraits)." },
        status: {
          type: "string",
          description: "active | churned | activeOrChurned. Default: active.",
          enum: ["active", "churned", "activeOrChurned"],
        },
        includeTraits: {
          type: "boolean",
          description: "Set to false to return slim {id,name,externalId,uri} per row. Default true.",
        },
        traits: {
          type: "array",
          items: { type: "string" },
          description: "If provided, return only these trait keys per row. Implies includeTraits=true.",
        },
        sortBy: {
          type: "string",
          description: "Top-level field (mrr, usersCount, nextRenewalDate, createdAt, updatedAt, healthScore, npsScore, name) or trait key (e.g. vitally.custom.arr). Switches to cache-mode.",
        },
        sortOrder: {
          type: "string",
          description: "asc or desc. Default desc. Nulls always sort last regardless of order.",
          enum: ["asc", "desc"],
        },
        filterTraits: {
          type: "object",
          description: "Object of trait key/value pairs for exact-match filtering (e.g. {\"vitally.custom.arrTier\": \"Tier 1\"}). Switches to cache-mode.",
        },
      },
    },
  },
  {
    name: "update_account",
    description:
      "Update an account (PUT /resources/accounts/:id). Set traits or rename. Some traits are guarded — see GUARDED_TRAITS list. Writing a guarded trait requires `force: true` to confirm.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Vitally account ID or externalId." },
        name: { type: "string", description: "New account name. Optional." },
        traits: { type: "object", description: "Object of trait keys to set. Set a value to null to clear. Guarded traits (e.g. vitally.custom.arr) reject without force=true." },
        force: { type: "boolean", description: "Set true to allow writing guarded traits (system-of-record values like ARR/MRR/status). Default false." },
      },
      required: ["accountId"],
    },
  },
  {
    name: "aggregate_accounts",
    description:
      "Aggregate the cached account list. Group by a trait key or top-level field; metric is count, sum, avg, min, or max. Examples: top ARR by tier, total active customers, avg ARR by sentiment.",
    inputSchema: {
      type: "object",
      properties: {
        groupBy: {
          type: "string",
          description: "Trait key or top-level field to group by. Pass null/omit to aggregate the whole population into one row.",
        },
        metric: {
          type: "string",
          description: "count | sum | avg | min | max",
          enum: ["count", "sum", "avg", "min", "max"],
        },
        metricField: {
          type: "string",
          description: "Trait key or top-level field used by sum/avg/min/max. Required unless metric=count.",
        },
        filterTraits: {
          type: "object",
          description: "Pre-filter with exact-match trait pairs.",
        },
        status: {
          type: "string",
          description: "active | churned | activeOrChurned. Default active.",
          enum: ["active", "churned", "activeOrChurned"],
        },
        limit: { type: "number", description: "Max group rows to return. Default 50." },
        sortByMetric: {
          type: "string",
          description: "asc or desc on the metric value. Default desc.",
          enum: ["asc", "desc"],
        },
      },
      required: ["metric"],
    },
  },
  {
    name: "get_account_health",
    description: "Get the health score breakdown for an account.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Vitally account ID." },
      },
      required: ["accountId"],
    },
  },
  {
    name: "get_account_conversations",
    description:
      "Get recent conversations for one account (paginated). The embedded `account` object on each row is omitted by default — pass includeAccount=true if you need it. `accountId` is preserved on each row.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Vitally account ID." },
        limit: { type: "number", description: "Maximum number of conversations (default: 10)." },
        from: { type: "string", description: "Cursor token for pagination." },
        includeAccount: { type: "boolean", description: "If true, embed the full account object on each row. Default false." },
      },
      required: ["accountId"],
    },
  },
  {
    name: "list_conversations",
    description:
      "Workspace-level paginated list of conversations. Returns {results, next}. Embedded `account` object per row is omitted by default (set includeAccount=true to restore).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Page size, max 100, default 50." },
        from: { type: "string", description: "Cursor token from the previous response's `next` field." },
        includeAccount: { type: "boolean", description: "If true, embed the full account object on each row. Default false." },
      },
    },
  },
  {
    name: "get_account_tasks",
    description:
      "Get tasks for one account. The MCP applies client-side `status` filtering (open | completed | archived) since the upstream endpoint ignores it. Filtering may scan up to 5 pages to fill `limit` — if that hits the cap and the upstream still has more, `truncated:true` is set. `includeAccount` defaults to false and `descriptionFormat` defaults to 'plain' (HTML stripped).",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Vitally account ID." },
        status: {
          type: "string",
          description: "open | completed | archived. Filtered client-side: open=!completedAt&&!archivedAt, completed=completedAt set, archived=archivedAt set.",
          enum: ["open", "completed", "archived"],
        },
        limit: { type: "number", description: "Maximum number of tasks (default: 10)." },
        from: { type: "string", description: "Cursor token for pagination." },
        includeAccount: { type: "boolean", description: "If true, embed the full account object on each row. Default false." },
        descriptionFormat: {
          type: "string",
          description: "plain (default) strips HTML tags and replaces images with [image]. html returns raw HTML.",
          enum: ["plain", "html"],
        },
      },
      required: ["accountId"],
    },
  },
  {
    name: "list_tasks",
    description:
      "Workspace-level paginated list of tasks. Vitally does NOT support server-side status/assignee/dueDate filters; filter client-side after retrieval. Embedded `account` per row is omitted by default; descriptions default to plain text.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Page size, max 100, default 50." },
        from: { type: "string", description: "Cursor token from the previous response's `next` field." },
        archived: { type: "boolean", description: "If true, include archived tasks. Default false." },
        includeAccount: { type: "boolean", description: "If true, embed the full account object on each row. Default false." },
        descriptionFormat: {
          type: "string",
          description: "plain (default) strips HTML; html keeps raw HTML.",
          enum: ["plain", "html"],
        },
      },
    },
  },
  {
    name: "create_task",
    description:
      "Create a new task. Calls POST /resources/tasks. Required: `name` plus either `accountId` or `organizationId`. `description` may include HTML. `assignedToId` is a Vitally Admin User ID; use `search_users` to look one up.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task name / subject. Required." },
        accountId: { type: "string", description: "Vitally account ID. Required unless organizationId is set." },
        organizationId: { type: "string", description: "Vitally organization ID. Required unless accountId is set." },
        description: { type: "string", description: "Task description (plain text or HTML)." },
        assignedToId: { type: "string", description: "Vitally Admin User ID of the assignee." },
        dueDate: { type: "string", description: "ISO 8601 date when the task is due." },
        categoryId: { type: "string", description: "Vitally ID of the Task Category." },
        externalId: { type: "string", description: "Unique ID of the task in your system." },
        tags: { type: "array", items: { type: "string" }, description: "Tags to attach to the task." },
        traits: { type: "object", description: "Custom trait key/value pairs." },
      },
      required: ["name"],
    },
  },
  {
    name: "update_task",
    description:
      "Update a task or mark it completed / reopen it. Calls PUT /resources/tasks/:id. `completed: true` sets `completedAt` to now (or to `completedAt` if given); `completed: false` reopens it (clears `completedAt` and `completedById`). Other fields (name, description, assignedToId, dueDate, categoryId, tags, traits) are optional; only the ones passed are changed.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Vitally task ID. Required." },
        completed: { type: "boolean", description: "true = mark completed, false = reopen. Omit to leave completion state unchanged." },
        completedAt: { type: "string", description: "ISO 8601 completion timestamp. Implies completed. Default: now when completed=true." },
        completedById: { type: "string", description: "Vitally Admin User ID of who completed the task (see list_admins). Optional." },
        name: { type: "string", description: "New task name / subject." },
        description: { type: "string", description: "New task description (plain text or HTML)." },
        assignedToId: { type: "string", description: "Vitally Admin User ID of the new assignee." },
        dueDate: { type: "string", description: "ISO 8601 due date." },
        categoryId: { type: "string", description: "Vitally ID of the Task Category." },
        tags: { type: "array", items: { type: "string" }, description: "Tags (replaces the existing list)." },
        traits: { type: "object", description: "Custom trait key/value pairs." },
      },
      required: ["taskId"],
    },
  },
  {
    name: "get_account_notes",
    description:
      "Get note metadata for an account (use get_note_by_id for a single note's full body). Embedded `account` per row is omitted by default; bodies default to plain text.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Vitally account ID." },
        limit: { type: "number", description: "Maximum number of notes (default: 10)." },
        from: { type: "string", description: "Cursor token for pagination." },
        includeAccount: { type: "boolean", description: "If true, embed the full account object on each row. Default false." },
        descriptionFormat: {
          type: "string",
          description: "plain (default) strips HTML from content/note; html keeps raw HTML.",
          enum: ["plain", "html"],
        },
      },
      required: ["accountId"],
    },
  },
  {
    name: "list_notes",
    description:
      "Workspace-level paginated list of notes. Returns {results, next}. Embedded `account` per row omitted by default; bodies default to plain text.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Page size, max 100, default 50." },
        from: { type: "string", description: "Cursor token from the previous response's `next` field." },
        archived: { type: "boolean", description: "If true, include archived notes. Default false." },
        accountId: {
          type: "string",
          description: "Optional. If provided, calls the per-account notes endpoint instead.",
        },
        includeAccount: { type: "boolean", description: "If true, embed the full account object on each row. Default false." },
        descriptionFormat: {
          type: "string",
          description: "plain (default) strips HTML from content/note; html keeps raw HTML.",
          enum: ["plain", "html"],
        },
      },
    },
  },
  {
    name: "get_note_by_id",
    description: "Retrieve full content of a specific note by ID. Body defaults to plain text.",
    inputSchema: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "Vitally note ID." },
        descriptionFormat: {
          type: "string",
          description: "plain (default) strips HTML; html keeps raw HTML.",
          enum: ["plain", "html"],
        },
      },
      required: ["noteId"],
    },
  },
  {
    name: "create_account_note",
    description:
      "Create a new note. Calls POST /resources/notes. The note body must go in `note` (not `content`). `subject` is the note title. `noteDate` defaults to now if omitted. Either `accountId` or `organizationId` is required.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Vitally account ID. Required unless organizationId is set." },
        organizationId: { type: "string", description: "Vitally organization ID. Required unless accountId is set." },
        note: { type: "string", description: "Note body (plain text or HTML)." },
        noteDate: {
          type: "string",
          description: "ISO 8601 timestamp for the note. Defaults to now if omitted.",
        },
        subject: { type: "string", description: "Note subject / title." },
        authorId: { type: "string", description: "Vitally Admin User ID of the note author." },
        categoryId: { type: "string", description: "Vitally ID of the Note Category." },
        externalId: { type: "string", description: "Unique ID of the note in your system." },
        tags: { type: "array", items: { type: "string" }, description: "Tags to attach to the note." },
        traits: { type: "object", description: "Custom trait key/value pairs." },
      },
      required: ["note"],
    },
  },
  {
    name: "list_projects",
    description:
      "Workspace-level paginated list of projects. Returns {results, next}.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Page size, max 100, default 50." },
        from: { type: "string", description: "Cursor token from the previous response's `next` field." },
        archived: { type: "boolean", description: "If true, include archived projects. Default false." },
      },
    },
  },
  {
    name: "get_project",
    description: "Get a single project by ID (GET /resources/projects/:id).",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Vitally project ID." },
      },
      required: ["projectId"],
    },
  },
  {
    name: "list_organizations",
    description:
      "Paginated list of organizations. Returns {results, next}.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Page size, max 100, default 50." },
        from: { type: "string", description: "Cursor token from the previous response's `next` field." },
      },
    },
  },
  {
    name: "refresh_accounts",
    description:
      "Fully re-sync the in-memory account cache from Vitally (all pages, active + churned). Returns the refreshed accounts with full payloads (traits, MRR, etc).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max accounts echoed back in the response (default 100). The cache itself is always fully re-synced." },
        includeTraits: {
          type: "boolean",
          description: "Set to false to return a slim {id,name,externalId,uri} shape. Default true.",
        },
      },
    },
  },
  {
    name: "list_custom_fields",
    description:
      "Discover the custom trait definitions for a given data model. Calls GET /resources/customFields?model=<model>. Use to learn which trait `path` keys exist on accounts/users/etc. before reading or writing them. For model=customObjects, also pass `customObjectId` (use list_custom_objects to find it).",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          enum: [
            "users",
            "accounts",
            "organizations",
            "customObjects",
            "tasks",
            "notes",
            "projects",
            "conversations",
            "team",
          ],
          description: "Data model whose custom trait definitions you want to list.",
        },
        customObjectId: {
          type: "string",
          description: "Required only when model=customObjects. Vitally ID of the Custom Object schema.",
        },
      },
      required: ["model"],
    },
  },
  {
    name: "list_custom_objects",
    description:
      "Paginated list of Custom Object schemas (definitions, not records) in the workspace. Calls GET /resources/customObjects. Use to discover Custom Object IDs needed by list_custom_fields with model=customObjects.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Page size, max 100, default 50." },
        from: { type: "string", description: "Cursor token from the previous response's `next` field." },
      },
    },
  },
  {
    name: "list_task_categories",
    description:
      "Paginated list of Task Categories. Calls GET /resources/taskCategories. Use to discover the `categoryId` values accepted by create_task.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Page size, max 100, default 50." },
        from: { type: "string", description: "Cursor token from the previous response's `next` field." },
      },
    },
  },
  {
    name: "list_note_categories",
    description:
      "Paginated list of Note Categories. Calls GET /resources/noteCategories. Use to discover the `categoryId` values accepted by create_account_note.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Page size, max 100, default 50." },
        from: { type: "string", description: "Cursor token from the previous response's `next` field." },
      },
    },
  },
  {
    name: "list_custom_object_records",
    description:
      "Read the RECORDS (instances) of a Custom Object — e.g. every Contract or Proposal, with their traits (renewal/upsell stage, proposed ARR, ...). `customObject` accepts the Vitally ID or the object name/label (e.g. \"contract\"; resolved via list_custom_objects). Without `accountId` calls GET /resources/customObjects/:id/instances (paginated {results, next}); with `accountId` calls .../instances/search?customerId=<id> (Vitally account UUID, no cursor). The embedded full `customer` account (+ `customers` array) is stripped by default — pass includeCustomer=true to keep it. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        customObject: { type: "string", description: "Custom Object Vitally ID, name, or label (case insensitive). Required." },
        accountId: { type: "string", description: "Vitally account UUID. If set, only records linked to this account are returned (search endpoint)." },
        limit: { type: "number", description: "Page size, max 100, default 50." },
        from: { type: "string", description: "Cursor token from the previous response's `next` field. Ignored when accountId is set (search has no cursor)." },
        includeCustomer: { type: "boolean", description: "If true, keep the embedded full customer account object(s) on each record. Default false (customerId is preserved)." },
      },
      required: ["customObject"],
    },
  },
  {
    name: "list_meetings",
    description:
      "Paginated list of Meetings ({results, next}). Workspace-wide by default; pass `accountId` for GET /resources/accounts/:id/meetings or `organizationId` for the org-scoped list. Embedded `account` per row omitted by default. Use get_meeting with includeTranscript=true for the transcript.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Vitally account ID or externalId. Scopes the list to one account." },
        organizationId: { type: "string", description: "Vitally organization ID. Scopes the list to one organization. Ignored if accountId is set." },
        limit: { type: "number", description: "Page size, max 100, default 50." },
        from: { type: "string", description: "Cursor token from the previous response's `next` field." },
        includeAccount: { type: "boolean", description: "If true, embed the full account object on each row. Default false." },
      },
    },
  },
  {
    name: "get_meeting",
    description:
      "Get a single meeting by ID (GET /resources/meetings/:id). With includeTranscript=true also fetches GET /resources/meetings/:id/transcript and attaches it as `transcript` (null + `transcriptNote` if none exists).",
    inputSchema: {
      type: "object",
      properties: {
        meetingId: { type: "string", description: "Vitally meeting ID or externalId." },
        includeTranscript: { type: "boolean", description: "If true, attach the meeting transcript. Default false." },
      },
      required: ["meetingId"],
    },
  },
  {
    name: "list_nps_responses",
    description:
      "Paginated list of NPS responses ({results, next}) — score 0-10, feedback text, respondedAt, userId. Workspace-wide by default; pass `accountId` for GET /resources/accounts/:id/npsResponses. Embedded `account` per row omitted by default.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Vitally account ID or externalId. Scopes the list to one account." },
        limit: { type: "number", description: "Page size, max 100, default 50." },
        from: { type: "string", description: "Cursor token from the previous response's `next` field." },
        includeAccount: { type: "boolean", description: "If true, embed the full account object on each row. Default false." },
      },
    },
  },
  {
    name: "list_survey_responses",
    description:
      "List the responses of one Custom Survey (GET /resources/surveys/:surveyId/responses). Each response carries `questionResponses` [{questionId, data:{type, value}}]. Vitally has NO endpoint to list surveys — take `surveyId` from the survey's URL in the Vitally UI.",
    inputSchema: {
      type: "object",
      properties: {
        surveyId: { type: "string", description: "Vitally survey ID (from the survey URL in the UI). Required." },
        limit: { type: "number", description: "Page size, max 100, default 50." },
        from: { type: "string", description: "Cursor token from the previous response's `next` field, if paginated." },
      },
      required: ["surveyId"],
    },
  },
  {
    name: "get_survey_response",
    description:
      "Get a single survey response with its answers (GET /resources/surveyResponses/:responseId).",
    inputSchema: {
      type: "object",
      properties: {
        responseId: { type: "string", description: "Vitally survey response ID. Required." },
      },
      required: ["responseId"],
    },
  },
  {
    name: "list_admins",
    description:
      "Paginated list of Admin users ({results, next}) — the workspace team members ({id, name, email, licenseStatus}). Use to resolve `assignedToId` for create_task and `authorId` for create_account_note.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Page size, max 100, default 50." },
        from: { type: "string", description: "Cursor token from the previous response's `next` field." },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: "vitally-api",
    version: "2.6.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    await ensureAccountsLoaded();
    return {
      resources: accountsCache.map(a => ({
        uri: `vitally://account/${a.id}`,
        mimeType: "application/json",
        name: a.name,
        description: `Vitally customer account: ${a.name}`,
      })),
    };
  } catch (err) {
    log("Error listing resources:", err instanceof Error ? err.message : String(err));
    return { resources: [] };
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const url = new URL(request.params.uri);
  const p = url.pathname.replace(/^\//, "");
  const [type, id] = p.split("/");
  if (type === "account") {
    const account = await callVitallyAPI<VitallyAccount>(`/resources/accounts/${encodeURIComponent(id)}`);
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(serializeAccount(account), null, 2),
        },
      ],
    };
  }
  throw new Error(`Resource type '${type}' not supported`);
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

// ---------------------------------------------------------------------------
// search_accounts handler — used directly and by find_account_by_name forward.
// ---------------------------------------------------------------------------

async function handleSearchAccounts(args: Record<string, unknown>) {
  const nameArg = args.name as string | undefined;
  const externalId = args.externalId as string | undefined;
  const limit = (args.limit as number | undefined) ?? 10;
  const includeTraitsRaw = args.includeTraits;
  const traits = Array.isArray(args.traits) ? (args.traits as string[]) : undefined;
  const includeTraits = includeTraitsRaw === undefined ? true : Boolean(includeTraitsRaw);
  if (!nameArg && !externalId) throw new Error("At least one of name or externalId is required");

  await ensureAccountsLoaded();
  let filtered = [...accountsCache];
  if (nameArg) {
    const needle = nameArg.toLowerCase();
    filtered = filtered.filter(a => a.name.toLowerCase().includes(needle));
  }
  if (externalId) filtered = filtered.filter(a => a.externalId === externalId);

  const limited = filtered.slice(0, limit);

  const conflictWarning =
    traits && traits.length > 0 && includeTraitsRaw === false
      ? "`traits` and includeTraits=false were both provided; `traits` wins."
      : null;

  const partial = limited.length < filtered.length;
  const payload: Record<string, unknown> = {
    count: limited.length,
    totalMatches: filtered.length,
    totalAccounts: accountsCache.length,
    partial,
    cacheComplete: accountsCacheComplete,
    cacheLoadedAt: accountsCacheLoadedAt,
    accounts: limited.map(a => projectAccount(a, includeTraits, traits)),
  };
  if (partial) {
    payload.note = `Returned ${limited.length} of ${filtered.length} matches; raise \`limit\` to get the rest.`;
  }
  if (!accountsCacheComplete) {
    payload.note = `${payload.note ? payload.note + " " : ""}Account cache is INCOMPLETE (sync hit the page cap); totalMatches/totalAccounts undercount the real base.`;
  }
  if (conflictWarning) payload.warning = conflictWarning;
  return jsonContent(payload);
}

function toolError(name: string, err: unknown) {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  log(`[vitally-mcp] tool ${name} failed: ${message}`);
  return {
    content: [{ type: "text", text: `Tool ${name} failed. ${message}` }],
    isError: true,
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments || {}) as Record<string, unknown>;
  const name = request.params.name;

  try {
  switch (name) {
    case "search_tools": {
      const keyword = String(args.keyword ?? "").toLowerCase();
      if (!keyword) throw new Error("keyword is required");
      const matches = TOOL_DEFINITIONS.filter(
        t => t.name.toLowerCase().includes(keyword) || t.description.toLowerCase().includes(keyword)
      ).map(t => ({
        name: t.name,
        description: t.description,
        requiredParams: t.inputSchema.required ?? [],
      }));
      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No tools found matching "${keyword}"` }] };
      }
      return jsonContent({ count: matches.length, tools: matches });
    }

    case "search_users": {
      const email = args.email as string | undefined;
      const externalId = args.externalId as string | undefined;
      const emailSubdomain = args.emailSubdomain as string | undefined;
      if (!email && !externalId && !emailSubdomain) {
        throw new Error("At least one of email, externalId, or emailSubdomain is required");
      }
      const data = await callVitallyAPI<VitallyPaginatedResponse<VitallyUser>>(
        `/resources/users/search${buildQuery({ email, externalId, emailSubdomain })}`
      );
      return jsonContent(data);
    }

    case "get_user": {
      const userId = args.userId as string | undefined;
      if (!userId) throw new Error("userId is required");
      const user = await callVitallyAPI<VitallyUser>(`/resources/users/${encodeURIComponent(userId)}`);
      return jsonContent(user);
    }

    case "search_accounts":
      return handleSearchAccounts(args);

    case "find_account_by_name": {
      // Deprecated — forwards to search_accounts. Tagged with a deprecation note.
      const forwarded = await handleSearchAccounts({
        name: args.name,
        includeTraits: args.includeTraits,
        traits: args.traits,
        limit: args.limit ?? 100,
      });
      const text = forwarded.content?.[0]?.text;
      if (typeof text === "string") {
        try {
          const parsed = JSON.parse(text);
          parsed._deprecation = "find_account_by_name is deprecated; use search_accounts instead.";
          return jsonContent(parsed);
        } catch {
          // fall through with original
        }
      }
      return forwarded;
    }

    case "get_account": {
      const accountId = args.accountId as string | undefined;
      const externalId = args.externalId as string | undefined;
      const idOrExt = accountId || externalId;
      if (!idOrExt) throw new Error("Either accountId or externalId is required");
      await ensureHealthSample();
      const account = await callVitallyAPI<VitallyAccount>(
        `/resources/accounts/${encodeURIComponent(idOrExt)}`
      );
      return jsonContent(attachWarnings(serializeAccount(account)));
    }

    case "list_accounts": {
      const limit = (args.limit as number | undefined) ?? 50;
      const from = args.from as string | undefined;
      const status = ((args.status as string | undefined) ?? "active") as "active" | "churned" | "activeOrChurned";
      const includeTraitsRaw = args.includeTraits;
      const traits = Array.isArray(args.traits) ? (args.traits as string[]) : undefined;
      const includeTraits = includeTraitsRaw === undefined ? true : Boolean(includeTraitsRaw);
      const sortBy = args.sortBy as string | undefined;
      const sortOrder = ((args.sortOrder as string | undefined) ?? "desc") as "asc" | "desc";
      const filterTraits = (args.filterTraits ?? null) as Record<string, unknown> | null;

      await ensureHealthSample();

      const conflictWarning =
        traits && traits.length > 0 && includeTraitsRaw === false
          ? "`traits` and includeTraits=false were both provided; `traits` wins."
          : null;

      const cacheMode = !!(sortBy || (filterTraits && Object.keys(filterTraits).length > 0));
      if (cacheMode) {
        await ensureAccountsLoaded();
        let rows = accountsCache.filter(a => isAccountActive(a, status));
        if (filterTraits) {
          rows = rows.filter(a => matchesFilterTraits(a, filterTraits));
        }
        if (sortBy) {
          rows = [...rows].sort((a, b) =>
            compareValues(getFieldValue(a, sortBy), getFieldValue(b, sortBy), sortOrder)
          );
        }
        const sliced = rows.slice(0, limit);
        const payload: Record<string, unknown> = {
          count: sliced.length,
          totalMatches: rows.length,
          totalAccounts: accountsCache.length,
          partial: sliced.length < rows.length,
          cacheComplete: accountsCacheComplete,
          cacheLoadedAt: accountsCacheLoadedAt,
          next: null,
          mode: "cache",
          results: sliced.map(a => projectAccount(a, includeTraits, traits)),
        };
        if (conflictWarning) payload.warning = conflictWarning;
        return jsonContent(attachWarnings(payload));
      }

      const data = await paginate<VitallyAccount>("/resources/accounts", { limit, from, status });
      const payload: Record<string, unknown> = {
        count: data.results.length,
        // Live pass-through: a non-null cursor is the only completeness signal.
        partial: data.next !== null,
        next: data.next,
        results: data.results.map(a => projectAccount(a, includeTraits, traits)),
      };
      if (conflictWarning) payload.warning = conflictWarning;
      return jsonContent(attachWarnings(payload));
    }

    case "update_account": {
      const accountId = args.accountId as string | undefined;
      if (!accountId) throw new Error("accountId is required");
      const force = Boolean(args.force);
      const traitsArg = args.traits as Record<string, unknown> | undefined;

      const guarded = findGuardedTraitWrites(traitsArg);
      if (guarded.length > 0 && !force) {
        throw new Error(
          `Refusing to write guarded trait(s) [${guarded.join(", ")}] without force=true. ` +
            `These flow in from system-of-record sources (billing, contract). ` +
            `If this is intentional, retry with force=true.`
        );
      }

      const payload: Record<string, unknown> = {};
      if (typeof args.name === "string") payload.name = args.name;
      if (traitsArg !== undefined) payload.traits = traitsArg;
      if (Object.keys(payload).length === 0) {
        throw new Error("update_account requires at least one of: name, traits");
      }
      const updated = await callVitallyAPI<VitallyAccount>(
        `/resources/accounts/${encodeURIComponent(accountId)}`,
        "PUT",
        payload
      );
      const idx = accountsCache.findIndex(a => a.id === updated.id);
      if (idx !== -1) accountsCache[idx] = updated;
      return jsonContent(serializeAccount(updated));
    }

    case "aggregate_accounts": {
      const groupBy = (args.groupBy as string | null | undefined) || null;
      const metric = args.metric as "count" | "sum" | "avg" | "min" | "max" | undefined;
      const metricField = args.metricField as string | undefined;
      const filterTraits = (args.filterTraits ?? null) as Record<string, unknown> | null;
      const status = ((args.status as string | undefined) ?? "active") as "active" | "churned" | "activeOrChurned";
      const limit = (args.limit as number | undefined) ?? 50;
      const sortByMetric = ((args.sortByMetric as string | undefined) ?? "desc") as "asc" | "desc";

      if (!metric) throw new Error("metric is required");
      if (metric !== "count" && !metricField) {
        throw new Error("metricField is required for sum, avg, min, max");
      }

      await ensureAccountsLoaded();
      await ensureHealthSample();

      let rows = accountsCache.filter(a => isAccountActive(a, status));
      if (filterTraits) rows = rows.filter(a => matchesFilterTraits(a, filterTraits));

      const groups = new Map<string, VitallyAccount[]>();
      if (groupBy) {
        for (const row of rows) {
          const key = String(getFieldValue(row, groupBy) ?? "__null__");
          const bucket = groups.get(key) ?? [];
          bucket.push(row);
          groups.set(key, bucket);
        }
      } else {
        groups.set("__all__", rows);
      }

      const out: { group: unknown; value: number; count: number }[] = [];
      for (const [groupKey, bucket] of groups.entries()) {
        const groupVal = groupKey === "__null__" ? null : groupKey === "__all__" ? null : groupKey;
        const count = bucket.length;
        if (metric === "count") {
          out.push({ group: groupVal, value: count, count });
          continue;
        }
        const numbers: number[] = [];
        for (const a of bucket) {
          const v = getFieldValue(a, metricField as string);
          if (typeof v === "number" && !Number.isNaN(v)) numbers.push(v);
        }
        if (numbers.length === 0) {
          out.push({ group: groupVal, value: 0, count });
          continue;
        }
        let value = 0;
        if (metric === "sum") value = numbers.reduce((a, b) => a + b, 0);
        else if (metric === "avg") value = numbers.reduce((a, b) => a + b, 0) / numbers.length;
        else if (metric === "min") value = Math.min(...numbers);
        else if (metric === "max") value = Math.max(...numbers);
        out.push({ group: groupVal, value, count });
      }

      out.sort((a, b) => (sortByMetric === "desc" ? b.value - a.value : a.value - b.value));
      const limited = out.slice(0, limit);

      return jsonContent(
        attachWarnings({
          metric,
          metricField: metricField ?? null,
          groupBy: groupBy ?? null,
          totalGroups: out.length,
          population: rows.length,
          cacheComplete: accountsCacheComplete,
          cacheLoadedAt: accountsCacheLoadedAt,
          rows: limited,
        })
      );
    }

    case "get_account_health": {
      const accountId = args.accountId as string | undefined;
      if (!accountId) throw new Error("accountId is required");
      const data = await callVitallyAPI<unknown>(
        `/resources/accounts/${encodeURIComponent(accountId)}/healthScores`
      );
      return jsonContent(data);
    }

    case "get_account_conversations": {
      const accountId = args.accountId as string | undefined;
      if (!accountId) throw new Error("accountId is required");
      const limit = (args.limit as number | undefined) ?? 10;
      const from = args.from as string | undefined;
      const includeAccount = Boolean(args.includeAccount);
      const data = await paginate<VitallyConversation>(
        `/resources/accounts/${encodeURIComponent(accountId)}/conversations`,
        { limit, from }
      );
      return jsonContent({
        results: data.results.map(r => stripAccountField(r, includeAccount)),
        next: data.next,
      });
    }

    case "list_conversations": {
      const limit = (args.limit as number | undefined) ?? 50;
      const from = args.from as string | undefined;
      const includeAccount = Boolean(args.includeAccount);
      const data = await paginate<VitallyConversation>("/resources/conversations", { limit, from });
      return jsonContent({
        results: data.results.map(r => stripAccountField(r, includeAccount)),
        next: data.next,
      });
    }

    case "get_account_tasks": {
      const accountId = args.accountId as string | undefined;
      if (!accountId) throw new Error("accountId is required");
      const limit = (args.limit as number | undefined) ?? 10;
      const from = args.from as string | undefined;
      const status = args.status as "open" | "completed" | "archived" | undefined;
      const includeAccount = Boolean(args.includeAccount);
      const descriptionFormat = ((args.descriptionFormat as string | undefined) ?? "plain") as "plain" | "html";

      const filtered = await fetchTasksWithStatusFilter(
        `/resources/accounts/${encodeURIComponent(accountId)}/tasks`,
        { from },
        status,
        limit
      );
      return jsonContent({
        results: filtered.results
          .map(t => transformTaskDescription(t, descriptionFormat))
          .map(t => stripAccountField(t, includeAccount)),
        next: filtered.next,
        pagesScanned: filtered.pagesScanned,
        truncated: filtered.truncated,
      });
    }

    case "list_tasks": {
      const limit = (args.limit as number | undefined) ?? 50;
      const from = args.from as string | undefined;
      const archived = args.archived as boolean | undefined;
      const includeAccount = Boolean(args.includeAccount);
      const descriptionFormat = ((args.descriptionFormat as string | undefined) ?? "plain") as "plain" | "html";
      const data = await paginate<VitallyTask>("/resources/tasks", { limit, from, archived });
      return jsonContent({
        results: data.results
          .map(t => transformTaskDescription(t, descriptionFormat))
          .map(t => stripAccountField(t, includeAccount)),
        next: data.next,
      });
    }

    case "create_task": {
      const taskName = args.name as string | undefined;
      const accountId = args.accountId as string | undefined;
      const organizationId = args.organizationId as string | undefined;
      if (!taskName) throw new Error("name is required");
      if (!accountId && !organizationId) {
        throw new Error("either accountId or organizationId is required");
      }
      const body: Record<string, unknown> = { name: taskName };
      if (accountId) body.accountId = accountId;
      if (organizationId) body.organizationId = organizationId;
      for (const k of ["description", "assignedToId", "dueDate", "categoryId", "externalId", "tags", "traits"] as const) {
        const v = args[k];
        if (v !== undefined) body[k] = v;
      }
      const created = await callVitallyAPI<VitallyTask>("/resources/tasks", "POST", body);
      return jsonContent({ success: true, task: created });
    }

    case "update_task": {
      const taskId = args.taskId as string | undefined;
      if (!taskId) throw new Error("taskId is required");
      const completed = args.completed as boolean | undefined;
      const completedAt = args.completedAt as string | undefined;
      if (completed === false && completedAt) {
        throw new Error("completedAt cannot be set together with completed=false");
      }
      const body: Record<string, unknown> = {};
      for (const k of ["name", "description", "assignedToId", "dueDate", "categoryId", "tags", "traits"] as const) {
        const v = args[k];
        if (v !== undefined) body[k] = v;
      }
      if (completed === true || completedAt) {
        body.completedAt = completedAt ?? new Date().toISOString();
        if (args.completedById !== undefined) body.completedById = args.completedById;
      } else if (completed === false) {
        body.completedAt = null;
        body.completedById = null;
      } else if (args.completedById !== undefined) {
        body.completedById = args.completedById;
      }
      if (Object.keys(body).length === 0) {
        throw new Error("update_task requires at least one field to change (e.g. completed, name, dueDate)");
      }
      const updated = await callVitallyAPI<VitallyTask>(
        `/resources/tasks/${encodeURIComponent(taskId)}`,
        "PUT",
        body
      );
      return jsonContent({ success: true, task: updated });
    }

    case "get_account_notes": {
      const accountId = args.accountId as string | undefined;
      if (!accountId) throw new Error("accountId is required");
      const limit = (args.limit as number | undefined) ?? 10;
      const from = args.from as string | undefined;
      const includeAccount = Boolean(args.includeAccount);
      const descriptionFormat = ((args.descriptionFormat as string | undefined) ?? "plain") as "plain" | "html";
      const data = await paginate<VitallyNote>(
        `/resources/accounts/${encodeURIComponent(accountId)}/notes`,
        { limit, from }
      );
      return jsonContent({
        results: data.results
          .map(n => transformNoteContent(n, descriptionFormat))
          .map(n => stripAccountField(n, includeAccount)),
        next: data.next,
      });
    }

    case "list_notes": {
      const limit = (args.limit as number | undefined) ?? 50;
      const from = args.from as string | undefined;
      const archived = args.archived as boolean | undefined;
      const accountId = args.accountId as string | undefined;
      const includeAccount = Boolean(args.includeAccount);
      const descriptionFormat = ((args.descriptionFormat as string | undefined) ?? "plain") as "plain" | "html";
      const endpoint = accountId
        ? `/resources/accounts/${encodeURIComponent(accountId)}/notes`
        : "/resources/notes";
      const data = await paginate<VitallyNote>(endpoint, { limit, from, archived });
      return jsonContent({
        results: data.results
          .map(n => transformNoteContent(n, descriptionFormat))
          .map(n => stripAccountField(n, includeAccount)),
        next: data.next,
      });
    }

    case "get_note_by_id": {
      const noteId = args.noteId as string | undefined;
      if (!noteId) throw new Error("noteId is required");
      const descriptionFormat = ((args.descriptionFormat as string | undefined) ?? "plain") as "plain" | "html";
      const note = await callVitallyAPI<VitallyNote>(`/resources/notes/${encodeURIComponent(noteId)}`);
      return jsonContent(transformNoteContent(note, descriptionFormat));
    }

    case "create_account_note": {
      const accountId = args.accountId as string | undefined;
      const organizationId = args.organizationId as string | undefined;
      const note = args.note as string | undefined;
      const noteDate = (args.noteDate as string | undefined) ?? new Date().toISOString();
      if (!note) throw new Error("note is required");
      if (!accountId && !organizationId) {
        throw new Error("either accountId or organizationId is required");
      }
      const body: Record<string, unknown> = { note, noteDate };
      if (accountId) body.accountId = accountId;
      if (organizationId) body.organizationId = organizationId;
      for (const k of ["subject", "authorId", "categoryId", "externalId", "tags", "traits"] as const) {
        const v = args[k];
        if (v !== undefined) body[k] = v;
      }
      const created = await callVitallyAPI<VitallyNote>("/resources/notes", "POST", body);
      return jsonContent({ success: true, note: created });
    }

    case "list_projects": {
      const limit = (args.limit as number | undefined) ?? 50;
      const from = args.from as string | undefined;
      const archived = args.archived as boolean | undefined;
      const data = await paginate<VitallyProject>("/resources/projects", { limit, from, archived });
      return jsonContent(data);
    }

    case "get_project": {
      const projectId = args.projectId as string | undefined;
      if (!projectId) throw new Error("projectId is required");
      const project = await callVitallyAPI<VitallyProject>(
        `/resources/projects/${encodeURIComponent(projectId)}`
      );
      return jsonContent(project);
    }

    case "list_organizations": {
      const limit = (args.limit as number | undefined) ?? 50;
      const from = args.from as string | undefined;
      const data = await paginate<VitallyOrganization>("/resources/organizations", { limit, from });
      return jsonContent(data);
    }

    case "refresh_accounts": {
      const limit = (args.limit as number | undefined) ?? 100;
      const includeTraits = args.includeTraits === undefined ? true : Boolean(args.includeTraits);
      await ensureAccountsLoaded(true);
      const rows = accountsCache.slice(0, limit);
      return jsonContent({
        count: rows.length,
        totalAccounts: accountsCache.length,
        partial: rows.length < accountsCache.length,
        cacheComplete: accountsCacheComplete,
        cacheLoadedAt: accountsCacheLoadedAt,
        pagesFetched: accountsCachePages,
        accounts: rows.map(a => projectAccount(a, includeTraits)),
      });
    }

    case "list_custom_fields": {
      const model = args.model as string | undefined;
      const customObjectId = args.customObjectId as string | undefined;
      const allowedModels = new Set([
        "users",
        "accounts",
        "organizations",
        "customObjects",
        "tasks",
        "notes",
        "projects",
        "conversations",
        "team",
      ]);
      if (!model) throw new Error("model is required");
      if (!allowedModels.has(model)) {
        throw new Error(`Invalid model "${model}". Must be one of: ${[...allowedModels].join(", ")}`);
      }
      if (model === "customObjects" && !customObjectId) {
        throw new Error("customObjectId is required when model=customObjects");
      }
      const data = await callVitallyAPI<unknown>(
        `/resources/customFields${buildQuery({ model, customObjectId })}`
      );
      return jsonContent(data);
    }

    case "list_custom_objects": {
      const limit = (args.limit as number | undefined) ?? 50;
      const from = args.from as string | undefined;
      const data = await paginate<Record<string, unknown>>("/resources/customObjects", { limit, from });
      return jsonContent(data);
    }

    case "list_task_categories": {
      const limit = (args.limit as number | undefined) ?? 50;
      const from = args.from as string | undefined;
      const data = await paginate<Record<string, unknown>>("/resources/taskCategories", { limit, from });
      return jsonContent(data);
    }

    case "list_note_categories": {
      const limit = (args.limit as number | undefined) ?? 50;
      const from = args.from as string | undefined;
      const data = await paginate<Record<string, unknown>>("/resources/noteCategories", { limit, from });
      return jsonContent(data);
    }

    case "list_custom_object_records": {
      const customObjectRef = args.customObject as string | undefined;
      if (!customObjectRef) throw new Error("customObject is required (Vitally ID, name, or label)");
      const accountId = args.accountId as string | undefined;
      const limit = (args.limit as number | undefined) ?? 50;
      const from = args.from as string | undefined;
      const includeCustomer = Boolean(args.includeCustomer);

      const schema = await resolveCustomObject(customObjectRef);
      const coId = encodeURIComponent(schema.id);

      let results: Record<string, unknown>[];
      let next: string | null = null;
      let mode: "list" | "search";
      if (accountId) {
        mode = "search";
        // The search endpoint returns a BARE ARRAY, not {results, next}.
        const raw = await callVitallyAPI<unknown>(
          `/resources/customObjects/${coId}/instances/search${buildQuery({ customerId: accountId, limit })}`
        );
        results = Array.isArray(raw)
          ? (raw as Record<string, unknown>[])
          : ((raw as { results?: Record<string, unknown>[] })?.results ?? []);
        results = results.slice(0, limit);
      } else {
        mode = "list";
        const page = await paginate<Record<string, unknown>>(
          `/resources/customObjects/${coId}/instances`,
          { limit, from }
        );
        results = page.results || [];
        next = page.next;
      }

      return jsonContent({
        customObject: { id: schema.id, name: schema.name ?? null, label: schema.label ?? null },
        mode,
        count: results.length,
        results: results.map(r => stripInstanceCustomer(r, includeCustomer)),
        next,
      });
    }

    case "list_meetings": {
      const accountId = args.accountId as string | undefined;
      const organizationId = args.organizationId as string | undefined;
      const limit = (args.limit as number | undefined) ?? 50;
      const from = args.from as string | undefined;
      const includeAccount = Boolean(args.includeAccount);
      const endpoint = accountId
        ? `/resources/accounts/${encodeURIComponent(accountId)}/meetings`
        : organizationId
          ? `/resources/organizations/${encodeURIComponent(organizationId)}/meetings`
          : "/resources/meetings";
      const data = await paginate<Record<string, unknown>>(endpoint, { limit, from });
      return jsonContent({
        results: (data.results || []).map(r => stripAccountField(r, includeAccount)),
        next: data.next,
      });
    }

    case "get_meeting": {
      const meetingId = args.meetingId as string | undefined;
      if (!meetingId) throw new Error("meetingId is required");
      const includeTranscript = Boolean(args.includeTranscript);
      const meeting = await callVitallyAPI<Record<string, unknown>>(
        `/resources/meetings/${encodeURIComponent(meetingId)}`
      );
      if (!includeTranscript) return jsonContent(meeting);
      try {
        const transcript = await callVitallyAPI<unknown>(
          `/resources/meetings/${encodeURIComponent(meetingId)}/transcript`
        );
        return jsonContent({ ...meeting, transcript });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonContent({ ...meeting, transcript: null, transcriptNote: `No transcript available: ${msg}` });
      }
    }

    case "list_nps_responses": {
      const accountId = args.accountId as string | undefined;
      const limit = (args.limit as number | undefined) ?? 50;
      const from = args.from as string | undefined;
      const includeAccount = Boolean(args.includeAccount);
      const endpoint = accountId
        ? `/resources/accounts/${encodeURIComponent(accountId)}/npsResponses`
        : "/resources/npsResponses";
      const data = await paginate<Record<string, unknown>>(endpoint, { limit, from });
      return jsonContent({
        results: (data.results || []).map(r => stripAccountField(r, includeAccount)),
        next: data.next,
      });
    }

    case "list_survey_responses": {
      const surveyId = args.surveyId as string | undefined;
      if (!surveyId) throw new Error("surveyId is required (take it from the survey URL in the Vitally UI)");
      const limit = (args.limit as number | undefined) ?? 50;
      const from = args.from as string | undefined;
      // Response envelope is not documented — normalize bare-array and
      // {results, next} shapes alike.
      const raw = await callVitallyAPI<unknown>(
        `/resources/surveys/${encodeURIComponent(surveyId)}/responses${buildQuery({ limit, from })}`
      );
      if (Array.isArray(raw)) {
        return jsonContent({ results: raw, next: null });
      }
      const page = raw as { results?: unknown[]; next?: string | null };
      return jsonContent({ results: page.results ?? [], next: page.next ?? null });
    }

    case "get_survey_response": {
      const responseId = args.responseId as string | undefined;
      if (!responseId) throw new Error("responseId is required");
      const data = await callVitallyAPI<unknown>(
        `/resources/surveyResponses/${encodeURIComponent(responseId)}`
      );
      return jsonContent(data);
    }

    case "list_admins": {
      const limit = (args.limit as number | undefined) ?? 50;
      const from = args.from as string | undefined;
      const data = await paginate<Record<string, unknown>>("/resources/admins", { limit, from });
      return jsonContent(data);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  } catch (err) {
    return toolError(name, err);
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  log("Server error:", err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
