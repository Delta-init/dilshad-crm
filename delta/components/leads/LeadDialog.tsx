"use client";
import { useEffect, useMemo } from "react";
import { useForm, Controller, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, MessageCircle } from "lucide-react";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  createLeadSchema,
  updateLeadSchema,
  type CreateLeadFormValues,
  type UpdateLeadFormValues,
} from "@/lib/validations/leadSchema";
import { useCreateLead, useUpdateLead } from "@/hooks/useLeads";
import { useAllCourses } from "@/hooks/useCourses";
import { useTeams, useTeam } from "@/hooks/useTeams";
import { useSheetSources } from "@/hooks/useSheetSources";
import type { Lead } from "@/types/lead";

// Every source can be picked (the owner, 2026-10-05) — Social Media, Direct and
// Other were switched off in the copy from Delta's CRM.
const FALLBACK_SOURCES = [
  { value: "website",  label: "Website" },
  { value: "referral", label: "Referral" },
  { value: "social",   label: "Social Media" },
  { value: "direct",   label: "Direct" },
  { value: "other",    label: "Other" },
];

interface LeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead?: Lead | null;
  mode?: "create" | "edit";
  /** Enrolled (2026-11-23): the course changes with Change course, which finance approves — not here. */
  courseLocked?: boolean;
}

export function LeadDialog({ open, onOpenChange, lead, mode, courseLocked }: LeadDialogProps) {
  const isEditing = mode === "edit" || !!lead;

  const { mutate: createLead, isPending: creating } = useCreateLead();
  const { mutate: updateLead, isPending: updating } = useUpdateLead();
  const { data: allCourses = [] } = useAllCourses();
  const { data: teamsData } = useTeams({ status: "active", limit: 100 });
  const teams = teamsData?.data ?? [];
  const { data: sheetSources = [] } = useSheetSources();
  // Flatten all source keys across active integrations; fall back to hardcoded list
  const activeSources = sheetSources.filter((s) => s.isActive);
  const SOURCES = activeSources.length > 0
    ? [
        ...activeSources.flatMap((s) =>
          s.sources.map((key) => ({
            value: key,
            label: `${s.name} · ${key}`,
          }))
        ),
        // Referral must always be selectable regardless of sheet integrations
        { value: "referral", label: "Referral" },
      ]
    : FALLBACK_SOURCES;

  const isPending = creating || updating;

  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
    formState: { errors },
  } = useForm<CreateLeadFormValues>({
    resolver: zodResolver(isEditing ? updateLeadSchema : createLeadSchema) as never,
    defaultValues: { name: "", email: "", phone: "", source: "", course: "", team: "", assignedTo: "" },
  });

  // Watch source — referral requires "referred by" details
  const sourceValue = useWatch({ control, name: "source" as never }) as string | undefined;
  const isReferralSource = !!sourceValue?.toLowerCase().includes("referral");

  // Watch team field to fetch its members
  const selectedTeamId = useWatch({ control, name: "team" as never }) as string | undefined;
  const { data: selectedTeam } = useTeam(selectedTeamId ?? "");

  // Build members list from selected team (leaders + members, deduped)
  const teamMembers = useMemo(() => {
    if (!selectedTeam) return [];
    const all = [
      ...(selectedTeam.leaders ?? []).map((u: { _id: string; name: string }) => ({ _id: u._id, name: u.name, role: "Leader" })),
      ...(selectedTeam.members ?? []).map((u: { _id: string; name: string }) => ({ _id: u._id, name: u.name, role: "Member" })),
    ];
    // dedupe by _id
    const seen = new Set<string>();
    return all.filter((u) => { if (seen.has(u._id)) return false; seen.add(u._id); return true; });
  }, [selectedTeam]);

  // When team changes, clear assignedTo so user picks a relevant person
  useEffect(() => {
    setValue("assignedTo" as never, "" as never);
  }, [selectedTeamId, setValue]);

  useEffect(() => {
    if (open) {
      if (lead) {
        reset({
          name:            lead.name,
          email:           lead.email ?? "",
          phone:           lead.phone ?? "",
          source:          lead.source ?? "",
          campaignId:      lead.campaignId ?? "",
          lastFollowupDate: lead.lastFollowupDate
            ? lead.lastFollowupDate.slice(0, 10)
            : "",
          demoScheduled:   lead.demoScheduled ?? false,
          demoAttended:    lead.demoAttended ?? false,
          hasWhatsapp:     lead.hasWhatsapp ?? false,
          sellingAmount:   lead.sellingAmount ?? null,
          course: (typeof lead.course === "object" && lead.course !== null)
            ? (lead.course as { _id: string })._id
            : (lead.course as string | null | undefined) ?? "",
          referralType: lead.referralType ?? null,
          referredBy:   lead.referredBy ?? "",
        } as UpdateLeadFormValues as never);
      } else {
        reset({ name: "", email: "", phone: "", source: "", campaignId: "", lastFollowupDate: "", demoScheduled: false, demoAttended: false, hasWhatsapp: true, sellingAmount: null, course: "", team: "", assignedTo: "", referralType: null, referredBy: "" });
      }
    }
  }, [open, lead, reset]);

  const onSubmit = (data: CreateLeadFormValues) => {
    const extended = data as CreateLeadFormValues & {
      campaignId?: string;
      lastFollowupDate?: string;
      demoScheduled?: boolean;
      demoAttended?: boolean;
      sellingAmount?: number | null;
    };
    const payload = {
      ...data,
      email:            data.email      || undefined,
      source:           data.source     || undefined,
      campaignId:       extended.campaignId || undefined,
      lastFollowupDate: extended.lastFollowupDate || undefined,
      demoScheduled:    extended.demoScheduled ?? false,
      demoAttended:     extended.demoAttended ?? false,
      sellingAmount:    extended.sellingAmount ?? null,
      course:           data.course     || undefined,
      team:             (data as CreateLeadFormValues).team       || undefined,
      assignedTo:       (data as CreateLeadFormValues).assignedTo || undefined,
      referredBy:       isReferralSource ? (data.referredBy?.trim() || undefined) : null,
      referralType:     isReferralSource ? (data.referralType ?? "external") : null,
    };

    if (isEditing && lead) {
      updateLead({ id: lead._id, data: payload }, { onSuccess: () => onOpenChange(false) });
    } else {
      // A new lead's source has passed the form's check — it is never blank here
      createLead({ ...payload, source: data.source }, { onSuccess: () => onOpenChange(false) });
    }
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent desktopClassName="max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{isEditing ? "Edit Lead" : "Create New Lead"}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        <form onSubmit={handleSubmit(onSubmit as never)} className="space-y-4 px-4 sm:px-0">
          <div className="grid grid-cols-2 gap-4">

            {/* Name */}
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="lead-name">Full Name *</Label>
              <Input id="lead-name" placeholder="John Doe" {...register("name")} />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>

            {/* Email */}
            <div className="space-y-1.5">
              <Label htmlFor="lead-email">Email <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input id="lead-email" type="email" placeholder="john@example.com" {...register("email")} />
              {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
            </div>

            {/* Phone + WhatsApp toggle */}
            <div className="space-y-1.5">
              <Label htmlFor="lead-phone">Phone *</Label>
              <Input id="lead-phone" placeholder="+91 98765 43210" {...register("phone")} />
              {errors.phone && <p className="text-xs text-destructive">{errors.phone.message}</p>}
              <Controller
                name={"hasWhatsapp" as never}
                control={control}
                render={({ field }: { field: { value: boolean; onChange: (v: boolean) => void } }) => (
                  <button
                    type="button"
                    onClick={() => field.onChange(!field.value)}
                    className={`mt-1 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all ${
                      field.value
                        ? "border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400"
                        : "border-border bg-muted text-muted-foreground hover:border-green-500/30 hover:text-green-600"
                    }`}
                  >
                    <MessageCircle className="h-3 w-3" />
                    {field.value ? "Has WhatsApp" : "No WhatsApp"}
                  </button>
                )}
              />
            </div>

            {/* Source */}
            <div className="space-y-1.5">
              <Label>Source{isEditing ? "" : " *"}</Label>
              <Controller
                name="source"
                control={control}
                render={({ field }) => (
                  <Select value={field.value ?? ""} onValueChange={field.onChange}>
                    <SelectTrigger aria-invalid={!!errors.source}><SelectValue placeholder="Select source" /></SelectTrigger>
                    <SelectContent>
                      {SOURCES.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.source && <p className="text-xs text-destructive">{errors.source.message}</p>}
            </div>

            {/* Referral details — mandatory when source is Referral */}
            {isReferralSource && (
              <div className="space-y-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
                <p className="text-[11px] font-semibold text-amber-500">
                  Referral details (mandatory)
                </p>
                <div className="space-y-1.5">
                  <Label>Referral Type <span className="text-destructive">*</span></Label>
                  <Controller
                    name={"referralType" as never}
                    control={control}
                    render={({ field }) => (
                      <Select value={(field.value as string | null) ?? ""} onValueChange={field.onChange}>
                        <SelectTrigger><SelectValue placeholder="Who referred this lead?" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="employee">Delta employee</SelectItem>
                          <SelectItem value="external">External referral</SelectItem>
                          <SelectItem value="student">Student</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lead-referred-by">Referred By (name) <span className="text-destructive">*</span></Label>
                  <Input
                    id="lead-referred-by"
                    placeholder="e.g. Ashik (student)"
                    {...register("referredBy" as never)}
                  />
                  {(errors as Record<string, { message?: string }>).referredBy?.message && (
                    <p className="text-xs text-destructive">
                      {(errors as Record<string, { message?: string }>).referredBy?.message}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Campaign ID */}
            <div className="space-y-1.5">
              <Label htmlFor="lead-campaign">Campaign ID</Label>
              <Input
                id="lead-campaign"
                placeholder="e.g. JUNE-FB-001"
                {...register("campaignId" as never)}
              />
            </div>

            {/* Last Follow-up Date */}
            <div className="space-y-1.5">
              <Label htmlFor="lead-followup">Last Follow-up Date</Label>
              <Input
                id="lead-followup"
                type="date"
                {...register("lastFollowupDate" as never)}
              />
            </div>

            {/* Demo Scheduled */}
            <div className="space-y-1.5">
              <Label>Demo Scheduled?</Label>
              <Controller
                name={"demoScheduled" as never}
                control={control}
                render={({ field }: { field: { value: boolean; onChange: (v: boolean) => void } }) => (
                  <Select
                    value={field.value ? "true" : "false"}
                    onValueChange={(v) => field.onChange(v === "true")}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="false">No</SelectItem>
                      <SelectItem value="true">Yes</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            {/* Demo Attended */}
            <div className="space-y-1.5">
              <Label>Demo Attended?</Label>
              <Controller
                name={"demoAttended" as never}
                control={control}
                render={({ field }: { field: { value: boolean; onChange: (v: boolean) => void } }) => (
                  <Select
                    value={field.value ? "true" : "false"}
                    onValueChange={(v) => field.onChange(v === "true")}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="false">No</SelectItem>
                      <SelectItem value="true">Yes</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            {/* Course */}
            <div className="space-y-1.5">
              <Label>Course</Label>
              <Controller
                name="course"
                control={control}
                render={({ field }) => (
                  <Select value={field.value ?? ""} onValueChange={field.onChange} disabled={courseLocked}>
                    <SelectTrigger><SelectValue placeholder="Select course" /></SelectTrigger>
                    <SelectContent>
                      {allCourses.map((c) => (
                        <SelectItem key={c._id} value={c._id || ""}>{c.name || ""}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {courseLocked && (
                <p className="text-[11px] text-muted-foreground">Enrolled — change the course with Change course on the lead; finance approves it.</p>
              )}
            </div>

            {/* Selling Amount */}
            <div className="space-y-1.5">
              <Label htmlFor="lead-selling-amount">
                Selling Amount
                <span className="text-muted-foreground text-xs ml-1">(negotiated price)</span>
              </Label>
              <Input
                id="lead-selling-amount"
                type="number"
                min={0}
                placeholder="e.g. 15000"
                {...register("sellingAmount" as never, {
                  setValueAs: (v: string) => (v === "" || v === undefined ? null : Number(v)),
                })}
              />
            </div>

            {/* ── Create-only fields ─────────────────────────────────────── */}
            {!isEditing && (
              <>
                {/* Team */}
                <div className="col-span-2 space-y-1.5">
                  <Label>Team <span className="text-muted-foreground text-xs">(optional)</span></Label>
                  <Controller
                    name={"team" as never}
                    control={control}
                    render={({ field }: { field: { value: string; onChange: (v: string) => void } }) => (
                      <Select value={field.value ?? ""} onValueChange={field.onChange}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a team" />
                        </SelectTrigger>
                        <SelectContent>
                          {teams.map((t) => (
                            <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>

                {/* Assigned To — members from selected team */}
                <div className="col-span-2 space-y-1.5">
                  <Label>
                    Assign To{" "}
                    <span className="text-muted-foreground text-xs">
                      {selectedTeamId ? "(team members)" : "(defaults to you)"}
                    </span>
                  </Label>
                  <Controller
                    name={"assignedTo" as never}
                    control={control}
                    render={({ field }: { field: { value: string; onChange: (v: string) => void } }) => (
                      <Select
                        value={field.value ?? ""}
                        onValueChange={field.onChange}
                        disabled={!selectedTeamId}
                      >
                        <SelectTrigger>
                          <SelectValue
                            placeholder={
                              selectedTeamId
                                ? teamMembers.length > 0
                                  ? "Select member"
                                  : "No members in team"
                                : "Select a team first"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {teamMembers.map((m) => (
                            <SelectItem key={m._id} value={m._id}>
                              {m.name}
                              <span className="ml-1.5 text-xs text-muted-foreground">({m.role})</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {!selectedTeamId && (
                    <p className="text-xs text-muted-foreground">
                      Leave blank to auto-assign to yourself.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>

          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              {isEditing ? "Save Changes" : "Create Lead"}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

export default LeadDialog;
