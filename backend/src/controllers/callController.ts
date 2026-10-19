import type { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import type { AuthenticatedRequest } from "../types/index.js";
import { Lead } from "../models/Lead.js";
import { CallLog } from "../models/CallLog.js";
import { isSuperAdmin } from "../services/commissionService.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { announceNewLeads } from "../services/leadAlertService.js";

const PROD_URL       = process.env.CRM_API_URL    ?? "https://api-crm.deltainstitutions.com";
const THREECX_BASE   = process.env.THREECX_URL    ?? "https://deltainstitutions.3cx.ae:5002";
const THREECX_CLIENT = process.env.THREECX_CLIENT_ID  ?? "deltaleads";
const THREECX_SECRET = process.env.THREECX_API_KEY    ?? "";

// ─── Token Cache ──────────────────────────────────────────────────────────────

let _cachedToken: string | null = null;
let _tokenExpiry  = 0;

async function get3cxToken(): Promise<string> {
  if (_cachedToken && Date.now() < _tokenExpiry - 10_000) return _cachedToken;

  const res = await fetch(`${THREECX_BASE}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     THREECX_CLIENT,
      client_secret: THREECX_SECRET,
    }).toString(),
  });

  if (!res.ok) throw new Error(`3CX token error: HTTP ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  _cachedToken = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000;
  return _cachedToken;
}

async function threecxGet(path: string): Promise<unknown> {
  const token = await get3cxToken();
  const res = await fetch(`${THREECX_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw Object.assign(new Error(`3CX API error ${res.status}: ${txt}`), { statusCode: res.status });
  }
  return res.json();
}

// ─── Phone normalisation ──────────────────────────────────────────────────────

function normalisePhone(raw: string): string {
  return raw.replace(/\D/g, "").replace(/^00/, "").replace(/^0/, "");
}

function phoneMatchQuery(raw: string) {
  const norm = normalisePhone(raw);
  if (!norm) return null;
  // Match last 9 digits to handle different country code formats
  const tail = norm.slice(-9);
  return { phone: { $regex: tail.replace(/\+/g, "\\+"), $options: "i" } };
}

// ─── GET /api/v1/calls/contact-lookup  (public — called by 3CX) ──────────────

export const contactLookup = async (req: Request, res: Response): Promise<void> => {
  const rawPhone = ((req.query.phone_number ?? req.query.phone ?? "") as string).trim();

  if (!rawPhone) {
    res.json({});
    return;
  }

  const query = phoneMatchQuery(rawPhone);
  if (!query) {
    res.json({});
    return;
  }

  const lead = await Lead.findOne(query).select("name email phone _id").lean();
  if (!lead) {
    res.json({});
    return;
  }

  const nameParts = (lead.name ?? "").split(" ");
  res.json({
    contact_id:   lead._id.toString(),
    first_name:   nameParts[0] ?? "",
    last_name:    nameParts.slice(1).join(" ") || "",
    email:        lead.email ?? "",
    phone_mobile: lead.phone ?? "",
    company_name: null,
    contact_url:  `https://crm.deltainstitutions.com/leads/${lead._id}`,
  });
};

// ─── GET /api/v1/calls/contact-search  (public — called by 3CX) ──────────────

export const contactSearch = async (req: Request, res: Response): Promise<void> => {
  const text = ((req.query.search_text ?? req.query.q ?? "") as string).trim();

  if (!text || text.length < 2) {
    res.json({ contacts: [] });
    return;
  }

  const regex = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const leads = await Lead.find({
    $or: [{ name: regex }, { phone: regex }, { email: regex }],
  })
    .select("name email phone _id")
    .limit(10)
    .lean();

  const contacts = leads.map((l) => ({
    contact_id:   l._id.toString(),
    first_name:   (l.name ?? "").split(" ")[0] ?? "",
    last_name:    (l.name ?? "").split(" ").slice(1).join(" ") || "",
    email:        l.email ?? "",
    phone_mobile: l.phone ?? "",
    contact_url:  `${PROD_URL.replace("api-crm", "crm").replace("/api", "")}/leads/${l._id}`,
  }));

  res.json({ contacts });
};

// ─── POST /api/v1/calls/contact-create  (public — called by 3CX) ─────────────

export const contactCreate = async (req: Request, res: Response): Promise<void> => {
  const { first_name = "", last_name = "", phone_mobile = "", email = "" } = req.body as {
    first_name?: string;
    last_name?:  string;
    phone_mobile?: string;
    email?:      string;
  };

  const phone = (phone_mobile || "").trim();
  const name  = `${first_name} ${last_name}`.trim() || phone;

  if (!phone) {
    res.status(400).json({ error: "phone_mobile is required" });
    return;
  }

  // Check if lead already exists (race-condition safe: upsert)
  const query = phoneMatchQuery(phone);
  if (query) {
    const existing = await Lead.findOne(query).select("_id name phone").lean();
    if (existing) {
      res.json({
        contact_id: existing._id.toString(),
        first_name: (existing.name ?? "").split(" ")[0],
        last_name:  (existing.name ?? "").split(" ").slice(1).join(" "),
        phone_mobile: existing.phone,
      });
      return;
    }
  }

  // For 3CX system-created leads we need a reporter — use super admin as fallback
  const { User } = await import("../models/User.js");
  const systemUser = await User.findOne({}).sort({ createdAt: 1 }).select("_id").lean();
  if (!systemUser) {
    res.status(500).json({ error: "No system user found to assign as reporter" });
    return;
  }

  const lead = await Lead.create({
    name,
    phone,
    email:     email || undefined,
    source:    "inbound_call",
    status:    "new",
    reporter:  systemUser._id,
  });

  // A caller nobody had as a lead: the Super Admins and the Sales Manager hear of it (2026-10-19).
  void announceNewLeads([lead._id]);


  res.status(201).json({
    contact_id:   lead._id.toString(),
    first_name,
    last_name,
    phone_mobile: phone,
  });
};

// ─── POST /api/v1/calls/journal  (public — called by 3CX after call ends) ────

export const journalCall = async (req: Request, res: Response): Promise<void> => {
  try {
  const body = req.body as {
    contact_id?:    string;
    call_type?:     string;
    call_direction?: string;
    duration?:      number;
    call_date?:     string;
    recording_url?: string;
    agent_extension?: string;
    agent_name?:    string;
    notes?:         string;
    phone_number?:  string;
    threecx_call_id?: string;
  };

  const phoneNumber = (body.phone_number ?? "").trim();
  if (!phoneNumber && !body.contact_id) {
    res.status(400).json({ error: "phone_number or contact_id is required" });
    return;
  }

  const rawType = (body.call_type ?? "Inbound").trim();
  const callType = (["Inbound", "Outbound", "Missed", "Notanswered"].includes(rawType)
    ? rawType
    : "Inbound") as "Inbound" | "Outbound" | "Missed" | "Notanswered";

  const rawDir = (body.call_direction ?? "inbound").toLowerCase();
  const callDirection = (rawDir === "outbound" ? "outbound" : "inbound") as "inbound" | "outbound";

  const parsedDate = body.call_date ? new Date(body.call_date) : null;
  const callDate   = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : new Date();
  const duration    = Number(body.duration ?? 0);
  const recordingUrl = body.recording_url
    ? (body.recording_url.startsWith("http") ? body.recording_url : `${THREECX_BASE}${body.recording_url}`)
    : null;

  // Resolve lead
  let leadId = null;
  let contactName: string | null = null;

  if (body.contact_id) {
    const lead = await Lead.findById(body.contact_id).select("_id name").lean();
    if (lead) {
      leadId = lead._id;
      contactName = lead.name;
    }
  }

  if (!leadId && phoneNumber) {
    const q = phoneMatchQuery(phoneNumber);
    if (q) {
      const lead = await Lead.findOne(q).select("_id name").lean();
      if (lead) {
        leadId = lead._id;
        contactName = lead.name;
      }
    }
  }

  const log = await CallLog.create({
    leadId,
    contactName,
    phoneNumber,
    callType,
    callDirection,
    callDuration:   duration,
    callDate,
    recordingUrl,
    agentExtension: body.agent_extension ?? null,
    agentName:      body.agent_name ?? null,
    source:         "3cx_journal",
    threecxCallId:  body.threecx_call_id ?? null,
  });

  // Update lead's last activity
  if (leadId) {
    await Lead.updateOne(
      { _id: leadId },
      { $set: { updatedAt: new Date() } },
    );
  }

  res.status(201).json({ success: true, call_log_id: log._id.toString() });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
};

// ─── GET|POST /api/v1/calls/webhook  (public — called by 3CX Parameters) ────
// 3CX sends GET with query params: phonenumber, duration, direction, type, extension, name, contact_id
// Also accepts POST JSON with same fields (from ReportCall scenario)

export const webhookJournal = async (req: Request, res: Response): Promise<void> => {
  try {
    // Merge query params + body (GET uses query, POST uses body)
    const p = { ...req.query, ...req.body } as Record<string, string>;

    const rawPhone = (p.phonenumber ?? p.phone_number ?? "").trim();
    const contactId = (p.contact_id ?? "").trim();

    if (!rawPhone && !contactId) {
      res.status(400).json({ error: "phonenumber or contact_id is required" });
      return;
    }

    // Map 3CX type → our callType enum
    const typeMap: Record<string, "Inbound" | "Outbound" | "Missed" | "Notanswered"> = {
      answered: "Inbound",
      inbound:  "Inbound",
      outbound: "Outbound",
      missed:   "Missed",
      notanswered: "Notanswered",
    };
    const rawType   = (p.type ?? p.call_type ?? "Answered").toLowerCase();
    const callType  = typeMap[rawType] ?? "Inbound";
    const rawDir    = (p.direction ?? p.call_direction ?? "Inbound").toLowerCase();
    const callDir   = rawDir === "outbound" ? "outbound" : "inbound";

    const duration  = Number(p.duration ?? 0);

    // Resolve lead
    let leadId = null;
    let contactName: string | null = p.name?.trim() || null;

    if (contactId) {
      const lead = await Lead.findById(contactId).select("_id name").lean();
      if (lead) { leadId = lead._id; contactName = lead.name ?? contactName; }
    }
    if (!leadId && rawPhone) {
      const q = phoneMatchQuery(rawPhone);
      if (q) {
        const lead = await Lead.findOne(q).select("_id name").lean();
        if (lead) { leadId = lead._id; contactName = lead.name ?? contactName; }
      }
    }

    // recording_url may be a relative path from 3CX or a full URL
    const rawRecording = p.recording_url ?? p.recording_path ?? null;
    const recordingUrl = rawRecording
      ? (rawRecording.startsWith("http") ? rawRecording : `${THREECX_BASE}${rawRecording}`)
      : null;

    const log = await CallLog.create({
      leadId,
      contactName,
      phoneNumber:    rawPhone || "unknown",
      callType,
      callDirection:  callDir as "inbound" | "outbound",
      callDuration:   duration,
      callDate:       new Date(),
      recordingUrl,
      agentExtension: p.extension ?? null,
      agentName:      p.agent_name ?? null,
      source:         "3cx_journal",
    });

    if (leadId) {
      await Lead.updateOne({ _id: leadId }, { $set: { updatedAt: new Date() } });
    }

    res.json({ success: true, call_log_id: log._id.toString() });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
};

// ─── GET /api/v1/calls/3cx-template  (public — download XML for 3CX admin) ───

export const get3cxTemplate = (_req: Request, res: Response): void => {
  const base = `${PROD_URL}/api/v1/calls`;

  // Shared PostValues block used by all 4 journal scenarios
  const journalPostValues = `
          <Value Key="phone_number" If="" SkipIf="" Passes="1" Type="String">[Number]</Value>
          <Value Key="call_type" If="" SkipIf="" Passes="1" Type="String">[CallType]</Value>
          <Value Key="call_direction" If="" SkipIf="" Passes="1" Type="String">[CallDirection]</Value>
          <Value Key="duration" If="" SkipIf="" Passes="1" Type="String">[Duration]</Value>
          <Value Key="call_date" If="" SkipIf="" Passes="1" Type="String">[DateTime]</Value>
          <Value Key="agent_extension" If="" SkipIf="" Passes="1" Type="String">[Agent]</Value>
          <Value Key="agent_name" If="" SkipIf="" Passes="1" Type="String">[AgentFirstName] [AgentLastName]</Value>
          <Value Key="name" If="" SkipIf="" Passes="1" Type="String">[Name]</Value>
          <Value Key="contact_id" If="" SkipIf="" Passes="1" Type="String">[EntityId]</Value>
          <Value Key="recording_url" If="" SkipIf="" Passes="1" Type="String">[RecordingUrl]</Value>`;

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<Crm xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" Country="AE" Name="Remote CRM" Version="2" SupportsEmojis="true" SupportsTranscription="true" ListPageSize="0">
  <Number Prefix="AsIs" MaxLength="15" />
  <Connection MaxConcurrentRequests="4" />
  <Parameters>
    <Parameter Name="URL" Type="String" Parent="General Configuration" Editor="String" Title="API URL:" Validation="" Default="${base}/" ListValues="" RequestUrl="" RequestUrlParameters="" ResponseScenario="" />
    <Parameter Name="CreateContactEnabled" Type="Boolean" Parent="" Editor="String" Title="Enable Contact Creation" Validation="" Default="True" ListValues="" RequestUrl="" RequestUrlParameters="" ResponseScenario="" />
    <Parameter Name="CreateOnCallDirection" Type="List" Parent="CreateContactEnabled" Editor="String" Title="Create Contacts on Call Direction:" Validation="" Default="Inbound" ListValues="Inbound,Inbound/Outbound" RequestUrl="" RequestUrlParameters="" ResponseScenario="" />
    <Parameter Name="CreateContactFirstName" Type="String" Parent="CreateContactEnabled" Editor="String" Title="New Contact First Name:" Validation="" Default="New" ListValues="" RequestUrl="" RequestUrlParameters="" ResponseScenario="" />
    <Parameter Name="CreateContactLastName" Type="String" Parent="CreateContactEnabled" Editor="String" Title="New Contact Last Name:" Validation="" Default="Lead [Number]" ListValues="" RequestUrl="" RequestUrlParameters="" ResponseScenario="" />
    <Parameter Name="ReportCallEnabled" Type="Boolean" Parent="" Editor="String" Title="Enable Call Journaling" Validation="" Default="True" ListValues="" RequestUrl="" RequestUrlParameters="" ResponseScenario="" />
    <Parameter Name="Subject" Type="String" Parent="ReportCallEnabled" Editor="String" Title="Call Subject:" Validation="" Default="Remote CRM Call" ListValues="" RequestUrl="" RequestUrlParameters="" ResponseScenario="" />
    <Parameter Name="InboundCallText" Type="String" Parent="ReportCallEnabled" Editor="String" Title="Answered Inbound Call:" Validation="" Default="[DateTime]: Answered incoming call from [Number] to [Agent] ([Duration])" ListValues="" RequestUrl="" RequestUrlParameters="" ResponseScenario="" />
    <Parameter Name="MissedCallText" Type="String" Parent="ReportCallEnabled" Editor="String" Title="Missed Call:" Validation="" Default="[DateTime]: Missed call from [Number] to [Agent]" ListValues="" RequestUrl="" RequestUrlParameters="" ResponseScenario="" />
    <Parameter Name="OutboundCallText" Type="String" Parent="ReportCallEnabled" Editor="String" Title="Answered Outbound Call:" Validation="" Default="[DateTime]: Answered outgoing call from [Agent] to [Number] ([Duration])" ListValues="" RequestUrl="" RequestUrlParameters="" ResponseScenario="" />
    <Parameter Name="NotAnsweredOutboundCallText" Type="String" Parent="ReportCallEnabled" Editor="String" Title="Unanswered Outbound Call:" Validation="" Default="[DateTime]: Unanswered outgoing call from [Agent] to [Number]" ListValues="" RequestUrl="" RequestUrlParameters="" ResponseScenario="" />
  </Parameters>
  <Authentication Type="No" />

  <Scenarios>

    <!-- ── Contact Lookup (inbound caller ID) ── -->
    <Scenario Id="" Type="REST" EntityId="" EntityOrder="">
      <Request SkipIf="" Url="[URL]contact-lookup?phonenumber=[Number]" MessagePasses="0" Message="" RequestContentType="" RequestEncoding="UrlEncoded" RequestType="Get" ResponseType="Json" />
      <Rules>
        <Rule Type="Any" Ethalon="">contact_id</Rule>
      </Rules>
      <Variables>
        <Variable Name="ContactID" LookupValue="" Path="contact_id"><Filter /></Variable>
        <Variable Name="FirstName" LookupValue="" Path="first_name"><Filter /></Variable>
        <Variable Name="LastName" LookupValue="" Path="last_name"><Filter /></Variable>
        <Variable Name="CompanyName" LookupValue="" Path="company_name"><Filter /></Variable>
        <Variable Name="Email" LookupValue="" Path="email"><Filter /></Variable>
        <Variable Name="PhoneMobile" LookupValue="" Path="phone_mobile"><Filter /></Variable>
      </Variables>
      <Outputs AllowEmpty="false">
        <Output Type="ContactID" Passes="0" Value="[ContactID]" />
        <Output Type="FirstName" Passes="0" Value="[FirstName]" />
        <Output Type="LastName" Passes="0" Value="[LastName]" />
        <Output Type="CompanyName" Passes="0" Value="[CompanyName]" />
        <Output Type="Email" Passes="0" Value="[Email]" />
        <Output Type="PhoneMobile" Passes="0" Value="[PhoneMobile]" />
        <Output Type="ContactUrl" Passes="0" Value="https://crm.deltainstitutions.com/leads/[ContactID]" />
        <Output Type="EntityId" Passes="0" Value="[ContactID]" />
        <Output Type="EntityType" Passes="0" Value="Leads" />
      </Outputs>
    </Scenario>

    <!-- ── Contact Search (by name/email) ── -->
    <Scenario Id="LookupByEmail" Type="REST" EntityId="" EntityOrder="">
      <Request SkipIf="" Url="[URL]contact-search?search_string=[Email]" MessagePasses="0" Message="" RequestContentType="" RequestEncoding="UrlEncoded" RequestType="Get" ResponseType="Json" />
      <Rules>
        <Rule Type="Any" Ethalon="">contacts.contact_id</Rule>
      </Rules>
      <Variables>
        <Variable Name="ContactID" LookupValue="" Path="contacts.contact_id"><Filter /></Variable>
        <Variable Name="FirstName" LookupValue="" Path="contacts.first_name"><Filter /></Variable>
        <Variable Name="LastName" LookupValue="" Path="contacts.last_name"><Filter /></Variable>
        <Variable Name="CompanyName" LookupValue="" Path="contacts.company_name"><Filter /></Variable>
        <Variable Name="Email" LookupValue="" Path="contacts.email"><Filter /></Variable>
        <Variable Name="PhoneMobile" LookupValue="" Path="contacts.phone_mobile"><Filter /></Variable>
      </Variables>
      <Outputs AllowEmpty="false">
        <Output Type="ContactID" Passes="0" Value="[ContactID]" />
        <Output Type="FirstName" Passes="0" Value="[FirstName]" />
        <Output Type="LastName" Passes="0" Value="[LastName]" />
        <Output Type="CompanyName" Passes="0" Value="[CompanyName]" />
        <Output Type="Email" Passes="0" Value="[Email]" />
        <Output Type="PhoneMobile" Passes="0" Value="[PhoneMobile]" />
        <Output Type="ContactUrl" Passes="0" Value="https://crm.deltainstitutions.com/leads/[ContactID]" />
        <Output Type="EntityId" Passes="0" Value="[ContactID]" />
        <Output Type="EntityType" Passes="0" Value="Leads" />
      </Outputs>
    </Scenario>

    <!-- ── Create Contact (unknown inbound caller) ── -->
    <Scenario Id="CreateContactRecord" Type="REST" EntityId="" EntityOrder="">
      <Request SkipIf="[CreateContactEnabled]!=True||[IIf([CreateOnCallDirection]==Inbound,[CallDirection]!=Inbound,False)]==True" Url="[URL]contact-create" MessagePasses="0" Message="" RequestContentType="application/json" RequestEncoding="Json" RequestType="Post" ResponseType="Json">
        <PostValues Key="" If="" SkipIf="">
          <Value Key="first_name" If="" SkipIf="" Passes="1" Type="String">[CreateContactFirstName]</Value>
          <Value Key="last_name" If="" SkipIf="" Passes="1" Type="String">[CreateContactLastName]</Value>
          <Value Key="phone_number" If="" SkipIf="" Passes="1" Type="String">[Number]</Value>
        </PostValues>
      </Request>
      <Rules>
        <Rule Type="Any" Ethalon="">contact_id</Rule>
      </Rules>
      <Variables>
        <Variable Name="ContactID" LookupValue="" Path="contact_id"><Filter /></Variable>
        <Variable Name="FirstName" LookupValue="" Path="first_name"><Filter /></Variable>
        <Variable Name="LastName" LookupValue="" Path="last_name"><Filter /></Variable>
      </Variables>
      <Outputs AllowEmpty="false">
        <Output Type="ContactID" Passes="0" Value="[ContactID]" />
        <Output Type="FirstName" Passes="0" Value="[FirstName]" />
        <Output Type="LastName" Passes="0" Value="[LastName]" />
        <Output Type="ContactUrl" Passes="0" Value="https://crm.deltainstitutions.com/leads/[ContactID]" />
        <Output Type="EntityId" Passes="0" Value="[ContactID]" />
        <Output Type="EntityType" Passes="0" Value="Leads" />
      </Outputs>
    </Scenario>

    <!-- ── Journal: Answered Inbound ── -->
    <Scenario Id="ReportCall" Type="REST" EntityId="" EntityOrder="">
      <Request SkipIf="[IIf([ReportCallEnabled]!=True||[EntityId]==&quot;&quot;,True,[IIf([CallType]!=Inbound,True,False)])]" Url="[URL]journal" MessagePasses="0" Message="" RequestContentType="application/json" RequestEncoding="Json" RequestType="Post" ResponseType="Json">
        <PostValues Key="" If="" SkipIf="">${journalPostValues}
        </PostValues>
      </Request>
      <Variables />
      <Outputs Next="ReportCallMissed" AllowEmpty="true" />
    </Scenario>

    <!-- ── Journal: Missed ── -->
    <Scenario Id="ReportCallMissed" Type="REST" EntityId="" EntityOrder="">
      <Request SkipIf="[IIf([ReportCallEnabled]!=True||[EntityId]==&quot;&quot;,True,[IIf([CallType]!=Missed,True,False)])]" Url="[URL]journal" MessagePasses="0" Message="" RequestContentType="application/json" RequestEncoding="Json" RequestType="Post" ResponseType="Json">
        <PostValues Key="" If="" SkipIf="">${journalPostValues}
        </PostValues>
      </Request>
      <Variables />
      <Outputs Next="ReportCallOutbound" AllowEmpty="true" />
    </Scenario>

    <!-- ── Journal: Answered Outbound ── -->
    <Scenario Id="ReportCallOutbound" Type="REST" EntityId="" EntityOrder="">
      <Request SkipIf="[IIf([ReportCallEnabled]!=True||[EntityId]==&quot;&quot;,True,[IIf([CallType]!=Outbound,True,False)])]" Url="[URL]journal" MessagePasses="0" Message="" RequestContentType="application/json" RequestEncoding="Json" RequestType="Post" ResponseType="Json">
        <PostValues Key="" If="" SkipIf="">${journalPostValues}
        </PostValues>
      </Request>
      <Variables />
      <Outputs Next="ReportCallNotanswered" AllowEmpty="true" />
    </Scenario>

    <!-- ── Journal: Not Answered Outbound ── -->
    <Scenario Id="ReportCallNotanswered" Type="REST" EntityId="" EntityOrder="">
      <Request SkipIf="[IIf([ReportCallEnabled]!=True||[EntityId]==&quot;&quot;,True,[IIf([CallType]!=Notanswered,True,False)])]" Url="[URL]journal" MessagePasses="0" Message="" RequestContentType="application/json" RequestEncoding="Json" RequestType="Post" ResponseType="Json">
        <PostValues Key="" If="" SkipIf="">${journalPostValues}
        </PostValues>
      </Request>
      <Variables />
      <Outputs AllowEmpty="false" />
    </Scenario>

  </Scenarios>
</Crm>`;

  res.setHeader("Content-Type", "application/xml");
  res.setHeader("Content-Disposition", 'attachment; filename="delta-crm-template.xml"');
  res.send(xml);
};

// ─── POST /api/v1/calls/click  (auth — log outbound click-to-call) ────────────

export const logClickToCall = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const phoneNumber = (req.query.phone_number as string)?.trim();
    const leadId      = (req.query.lead_id as string)?.trim() || null;

    if (!phoneNumber) {
      sendError(res, "phone_number is required", 400);
      return;
    }

    const { User } = await import("../models/User.js");
    const user = await User.findById(req.user!.userId).select("name extension").lean() as { name?: string; extension?: string } | null;
    const extension = user?.extension ?? null;
    const agentName = user?.name ?? req.user!.email;

    // Persist to CallLog
    const log = await CallLog.create({
      leadId:         leadId ?? null,
      phoneNumber,
      callType:       "Outbound",
      callDirection:  "outbound",
      callDuration:   0,
      callDate:       new Date(),
      agentExtension: extension,
      agentName,
      initiatedBy:    req.user!.userId,
      source:         "click_to_call",
    });

    // Pressing Call is a contact, as the old call counter had it — the counts come from 3CX since 2026-10-14, these
    // dates still from here: lastContactedAt and lastFollowupDate now, and firstContactTime on the assigned agent's
    // first call. Inactive Leads, the missed follow-up warning and the response-time reports read them. Only for
    // someone who may edit leads, as that counter's route asked: the click itself needs no more than a sign-in.
    const role = req.user!.role;
    const mayWorkLeads = isSuperAdmin(role) || role?.permissions?.leads?.edit === true;
    if (leadId && Types.ObjectId.isValid(leadId) && mayWorkLeads) {
      const now = new Date();
      await Lead.updateOne({ _id: leadId }, { $set: { lastContactedAt: now, lastFollowupDate: now } });
      await Lead.updateOne(
        { _id: leadId, assignedTo: req.user!.userId, firstContactTime: null },
        { $set: { firstContactTime: now } },
      );
    }

    sendSuccess(res, "Call logged", {
      callLogId:       log._id.toString(),
      phoneNumber,
      leadId,
      extension,
      initiatedBy:     req.user!.userId,
      initiatedByName: agentName,
      timestamp:       new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/v1/calls/lead/:leadId  (auth — call history for a lead) ─────────

export const getLeadCalls = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const lead = await Lead.findById(req.params.leadId).select("phone").lean();
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    const phone = lead.phone;

    // First: try our own CallLog collection (populated by journal endpoint)
    const norm = normalisePhone(phone);
    const tail = norm.slice(-9);
    const localLogs = await CallLog.find({
      $or: [
        { leadId: lead._id },
        { phoneNumber: { $regex: tail, $options: "i" } },
      ],
    })
      .sort({ callDate: -1 })
      .limit(100)
      .lean();

    if (localLogs.length > 0) {
      const calls = localLogs.map((r) => ({
        id:           r._id.toString(),
        startTime:    r.callDate.toISOString(),
        duration:     r.callDuration ?? 0,
        direction:    r.callDirection,
        status:       r.callType,
        callerNumber: r.callDirection === "inbound" ? phone : (r.agentExtension ?? ""),
        calleeNumber: r.callDirection === "outbound" ? phone : (r.agentExtension ?? ""),
        agentName:    r.agentName ?? null,
        recordingUrl: r.recordingUrl ?? null,
      }));
      sendSuccess(res, "Call logs fetched", { calls, phone, total: calls.length, source: "local" });
      return;
    }

    // Fallback: try 3CX XAPI (requires Admin role on service principal)
    let rawData: unknown;
    try {
      rawData = await threecxGet(
        `/xapi/v1/ReportCallLogData?$top=200&$orderby=StartTime%20desc`,
      );
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 403 || e.statusCode === 401) {
        sendSuccess(res, "Call logs unavailable — check 3CX service principal role", {
          calls: [],
          phone,
          hint: "Set Role = Admin in 3CX Admin → Integrations → API → Edit Service Principal",
        });
        return;
      }
      throw err;
    }

    type CdrRow = {
      StartTime:    string;
      Duration:     number;
      CallerNumber: string;
      CalleeNumber: string;
      Direction:    string;
      Status:       string;
      RecordingUrl?: string;
      AgentName?:  string;
      Id?:          string;
    };

    const rows: CdrRow[] = Array.isArray((rawData as { value?: CdrRow[] }).value)
      ? ((rawData as { value: CdrRow[] }).value)
      : (Array.isArray(rawData) ? (rawData as CdrRow[]) : []);

    const calls = rows
      .filter((r) => {
        const caller = normalisePhone(r.CallerNumber ?? "");
        const callee = normalisePhone(r.CalleeNumber ?? "");
        return caller.endsWith(norm) || callee.endsWith(norm) ||
               norm.endsWith(caller)  || norm.endsWith(callee);
      })
      .map((r) => ({
        id:           r.Id ?? `${r.StartTime}-${r.CallerNumber}`,
        startTime:    r.StartTime,
        duration:     r.Duration ?? 0,
        direction:    r.Direction ?? "outbound",
        status:       r.Status ?? "answered",
        callerNumber: r.CallerNumber,
        calleeNumber: r.CalleeNumber,
        agentName:    r.AgentName ?? null,
        recordingUrl: r.RecordingUrl ? `${THREECX_BASE}${r.RecordingUrl}` : null,
      }));

    sendSuccess(res, "Call logs fetched", { calls, phone, total: calls.length, source: "3cx_api" });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/v1/calls/recent  (auth — recent calls across all leads) ────────

export const getRecentCalls = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const logs  = await CallLog.find({})
      .sort({ callDate: -1 })
      .limit(limit)
      .populate("leadId", "name phone")
      .populate("initiatedBy", "name")
      .lean();

    sendSuccess(res, "Recent calls fetched", { calls: logs, total: logs.length });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/v1/calls/qc-queue  (auth — calls with recordings pending QC) ───

export const getQcQueue = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const status = (req.query.status as string) ?? "pending";
    const limit  = Math.min(Number(req.query.limit ?? 50), 200);
    const page   = Math.max(1, Number(req.query.page ?? 1));
    const skip   = (page - 1) * limit;

    const filter: Record<string, unknown> = { recordingUrl: { $ne: null } };
    if (status !== "all") filter.qcStatus = status;

    const [logs, total] = await Promise.all([
      CallLog.find(filter)
        .sort({ callDate: -1 })
        .skip(skip)
        .limit(limit)
        .populate("leadId", "name phone")
        .populate("qcReviewedBy", "name")
        .lean(),
      CallLog.countDocuments(filter),
    ]);

    sendSuccess(res, "QC queue fetched", { calls: logs, total, page, limit });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /api/v1/calls/:callId/qc  (auth — save QC review) ──────────────────

export const updateQc = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { callId } = req.params;
    const { qcRating, qcNotes, qcStatus } = req.body as {
      qcRating?: number;
      qcNotes?:  string;
      qcStatus?: "pending" | "reviewed" | "flagged";
    };

    const log = await CallLog.findById(callId);
    if (!log) { sendError(res, "Call log not found", 404); return; }

    if (qcRating !== undefined) {
      if (qcRating < 1 || qcRating > 5) { sendError(res, "qcRating must be 1–5", 400); return; }
      log.qcRating = qcRating;
    }
    if (qcNotes  !== undefined) log.qcNotes  = qcNotes;
    if (qcStatus !== undefined) log.qcStatus = qcStatus;

    // Stamp reviewer + timestamp when marking reviewed or flagged
    if (qcStatus && qcStatus !== "pending") {
      log.qcReviewedBy = req.user!.userId as unknown as import("mongoose").Types.ObjectId;
      log.qcReviewedAt = new Date();
    }

    await log.save();
    sendSuccess(res, "QC review saved", log.toJSON());
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/v1/calls/:callId  (auth — single call detail) ─────────────────

export const getCallById = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const log = await CallLog.findById(req.params.callId)
      .populate("leadId", "name phone email status")
      .populate("initiatedBy", "name email")
      .populate("qcReviewedBy", "name")
      .lean();

    if (!log) { sendError(res, "Call log not found", 404); return; }
    sendSuccess(res, "Call fetched", log);
  } catch (err) {
    next(err);
  }
};
