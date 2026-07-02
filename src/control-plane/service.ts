import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ApiKey,
  ApiScope,
  Artifact,
  CanaryDecision,
  CapabilityPolicy,
  CustomDomain,
  DeployPreview,
  DeployPreviewEnvironment,
  DeployPreviewPreviousRoute,
  Deployment,
  KvNamespace,
  Organization,
  Project,
  ProjectMembership,
  ProjectRole,
  RoutePointer,
  RouteSnapshot,
  RouteSnapshotPublication,
  RouteSnapshotPublicationTarget,
  RouteTarget,
  RuntimeNode,
  RuntimeNodeCapacity,
  RuntimeNodeStatus,
  RuntimeLimits,
  RuntimeSpec,
  Secret,
  ProjectUsageSummary,
  UsageEvent,
  UsageMetricName,
  UsageDimensions,
  User,
} from "./contracts.ts";
import {
  normalizeCapabilities,
  normalizeApiKeyName,
  normalizeApiScopes,
  normalizeArtifactProvenance,
  normalizeArtifactSignature,
  normalizeDigest,
  normalizeHost,
  normalizeKvNamespaceName,
  normalizeLimits,
  normalizeLocation,
  normalizeOrganizationName,
  normalizePathPrefix,
  normalizeProjectRole,
  normalizeProjectName,
  normalizeRuntime,
  normalizeRouteTargets,
  normalizeRuntimeNodeCapacity,
  normalizeRuntimeNodeHostInfo,
  normalizeRuntimeNodeIdentity,
  normalizeRuntimeNodeLabels,
  normalizeRuntimeNodeLoad,
  normalizeRuntimeNodeRegion,
  normalizeRuntimeNodeStatus,
  normalizeRuntimeNodeUrl,
  normalizeSecretName,
  normalizeSecretValue,
  normalizeSizeBytes,
  normalizeUsageDimensions,
  normalizeUsageMetricName,
  normalizeUsageQuantity,
  normalizeUsageTimestamp,
  normalizeUserEmail,
  normalizeUserName,
  normalizeWorld,
  optionalId,
  workerWorldVersion,
} from "./contracts.ts";
import type { ControlPlaneRepository, ProjectResourceUsage } from "./repository.ts";
import { ControlPlaneError } from "./errors.ts";
import type { ApiToken } from "./authz.ts";
import type { SecretCipher } from "./secret-encryption.ts";
import { enforceProjectQuota, type ProjectQuotaResource, type ProjectQuotas } from "./quotas.ts";
import type { ArtifactSignatureVerifier } from "./artifact-signing.ts";
import {
  enforceArtifactAdmissionPolicy,
  enforceDeploymentAdmissionPolicy,
  type ControlPlaneAdmissionPolicy,
} from "./admission.ts";
import {
  analyzeCanaryEvents,
  type CanaryAnalysisThresholds,
  type CanaryMetricEvent,
} from "./canary-analysis.ts";
import {
  createProjectEnforcementReport,
  type ProjectEnforcementPolicies,
  type ProjectEnforcementReport,
} from "./enforcement-report.ts";
import {
  createProjectUsageQuotaReport,
  enforceProjectUsageQuota,
  usageQuotaPeriodFor,
  type ProjectUsageQuotaPolicies,
  type ProjectUsageQuotaReport,
} from "./usage-quota.ts";
import {
  createOrganizationBillingStatement,
  createProjectBillingStatement,
  type OrganizationBillingStatement,
  type ProjectBillingRates,
  type ProjectBillingStatement,
} from "./billing-statement.ts";
import {
  createProjectBillingBudgetReport,
  enforceProjectBillingBudget,
  type ProjectBillingBudgetPolicies,
  type ProjectBillingBudgetReport,
} from "./billing-budget.ts";
import {
  createOrganizationBillingInvoice,
  type OrganizationBillingInvoice,
} from "./billing-invoice.ts";

export interface ControlPlaneOptions {
  repository: ControlPlaneRepository;
  idGenerator?: (prefix: string) => string;
  now?: () => string;
  runtimeNodeActiveTtlMs?: number;
  secretCipher?: SecretCipher;
  projectQuotas?: ProjectQuotas;
  projectEnforcementPolicies?: ProjectEnforcementPolicies;
  projectUsageQuotas?: ProjectUsageQuotaPolicies;
  projectBillingRates?: ProjectBillingRates;
  projectBillingBudgets?: ProjectBillingBudgetPolicies;
  billingRateCardVersion?: string;
  artifactSignatureVerifier?: ArtifactSignatureVerifier;
  admissionPolicy?: ControlPlaneAdmissionPolicy;
}

export interface CreateOrganizationInput {
  id?: string;
  name: string;
}

export interface CreateUserInput {
  id?: string;
  email: string;
  name?: string;
}

export interface CreateProjectInput {
  id?: string;
  organizationId?: string;
  name: string;
}

export interface AddProjectMembershipInput {
  projectId: string;
  userId: string;
  role: ProjectRole;
}

export interface ListProjectMembershipsInput {
  projectId: string;
}

export interface CreateApiKeyInput {
  id?: string;
  organizationId?: string;
  projectId?: string;
  name: string;
  scopes: ApiScope[];
}

export interface CreateApiKeyOutput {
  apiKey: ApiKey;
  token: string;
}

export interface AuthenticateApiTokenInput {
  token: string;
}

export interface ListProjectApiKeysInput {
  projectId: string;
}

export interface RecordUsageEventInput {
  id?: string;
  projectId: string;
  metric: UsageMetricName;
  quantity: number;
  dimensions?: UsageDimensions;
  recordedAt?: string;
}

export interface GetProjectUsageSummaryInput {
  projectId: string;
  from?: string;
  to?: string;
}

export interface GetProjectEnforcementReportInput {
  projectId: string;
  from?: string;
  to?: string;
}

export interface GetProjectUsageQuotaReportInput {
  projectId: string;
  at?: string;
}

export interface GetProjectBillingStatementInput {
  projectId: string;
  at?: string;
}

export interface GetProjectBillingBudgetReportInput {
  projectId: string;
  at?: string;
}

export interface GetOrganizationBillingStatementInput {
  organizationId: string;
  at?: string;
}

export interface IssueOrganizationBillingInvoiceInput {
  id?: string;
  organizationId: string;
  at?: string;
}

export interface GetBillingInvoiceInput {
  id: string;
}

export interface ListOrganizationBillingInvoicesInput {
  organizationId: string;
}

export interface CreateCustomDomainInput {
  id?: string;
  projectId: string;
  host: string;
}

export interface ListProjectCustomDomainsInput {
  projectId: string;
}

export interface VerifyCustomDomainOwnershipInput {
  id: string;
  txtRecords: unknown;
}

export interface RequestCustomDomainTlsProvisioningInput {
  id: string;
  provider?: string;
  requestId?: string;
}

export interface CompleteCustomDomainTlsProvisioningInput {
  id: string;
  ok: boolean;
  provider?: string;
  requestId?: string;
  error?: string;
}

export interface CreateDeployPreviewInput {
  id?: string;
  projectId: string;
  deploymentId: string;
  host?: string;
  pathPrefix?: string;
  environment?: unknown;
}

export interface ListProjectDeployPreviewsInput {
  projectId: string;
}

export interface RollbackDeployPreviewInput {
  id: string;
}

export interface CreateArtifactInput {
  id?: string;
  projectId: string;
  digest: string;
  location: string;
  sizeBytes: number;
  signature?: unknown;
  provenance?: unknown;
}

export interface GetProjectArtifactByDigestInput {
  projectId: string;
  digest: string;
}

export interface GetProjectUsageInput {
  projectId: string;
}

export interface CreateSecretInput {
  id?: string;
  projectId: string;
  name: string;
  value: string;
}

export interface GetSecretInput {
  id: string;
}

export interface ListProjectSecretsInput {
  projectId: string;
}

export interface UpdateSecretValueInput {
  id: string;
  value: string;
}

export interface DeleteSecretInput {
  id: string;
}

export interface CreateKvNamespaceInput {
  id?: string;
  projectId: string;
  name: string;
}

export interface GetKvNamespaceInput {
  id: string;
}

export interface ListProjectKvNamespacesInput {
  projectId: string;
}

export interface DeleteKvNamespaceInput {
  id: string;
}

export interface CreateDeploymentInput {
  id?: string;
  projectId: string;
  artifactId: string;
  world: string;
  runtime: RuntimeSpec;
  limits: RuntimeLimits;
  capabilities: Partial<CapabilityPolicy>;
}

export interface PointRouteInput {
  id?: string;
  projectId: string;
  host: string;
  pathPrefix: string;
  deploymentId?: string;
  targets?: RouteTarget[];
}

export interface StartRouteCanaryInput {
  projectId: string;
  host: string;
  pathPrefix: string;
  deploymentId: string;
  weight: number;
}

export interface RollbackRouteInput {
  projectId: string;
  host: string;
  pathPrefix: string;
  deploymentId?: string;
}

export interface AnalyzeRouteCanaryInput {
  projectId: string;
  host: string;
  pathPrefix: string;
  candidateDeploymentId: string;
  events: CanaryMetricEvent[];
  thresholds: CanaryAnalysisThresholds;
}

export interface AnalyzeRouteCanaryOutput {
  decision: CanaryDecision;
  route: RoutePointer;
}

export interface RegisterRuntimeNodeInput {
  id?: string;
  url: string;
  status?: RuntimeNodeStatus;
  region?: string;
  labels?: Record<string, string>;
  identity?: unknown;
  host?: unknown;
}

export interface RecordRuntimeNodeHeartbeatInput {
  id: string;
  status?: RuntimeNodeStatus;
  version?: string;
  capacity?: RuntimeNodeCapacity;
  load?: RuntimeNode["load"];
  identity?: unknown;
  host?: unknown;
}

export interface UpdateRuntimeNodeStatusInput {
  id: string;
  status: RuntimeNodeStatus;
}

export interface CleanupRuntimeNodesInput {
  olderThanMs: number;
  statuses?: unknown;
}

export interface CleanupRuntimeNodesOutput {
  cutoff: string;
  removed: RuntimeNode[];
}

export interface RecordRouteSnapshotPublicationInput {
  snapshotId?: string;
  snapshotGeneratedAt: string;
  routes: number;
  ok: boolean;
  targets: RouteSnapshotPublicationTarget[];
}

export function createControlPlane(options: ControlPlaneOptions) {
  const repository = options.repository;
  const idGenerator = options.idGenerator ?? defaultIdGenerator;
  const now = options.now ?? (() => new Date().toISOString());
  const runtimeNodeActiveTtlMs = options.runtimeNodeActiveTtlMs;
  const secretCipher = options.secretCipher;
  const projectQuotas = options.projectQuotas;
  const projectEnforcementPolicies = options.projectEnforcementPolicies;
  const projectUsageQuotas = options.projectUsageQuotas;
  const projectBillingRates = options.projectBillingRates;
  const projectBillingBudgets = options.projectBillingBudgets;
  const billingRateCardVersion = normalizeBillingRateCardVersion(options.billingRateCardVersion);
  const artifactSignatureVerifier = options.artifactSignatureVerifier;
  const admissionPolicy = options.admissionPolicy;

  function createOrganization(input: CreateOrganizationInput): Organization {
    const organization: Organization = {
      id: optionalId(input.id, "organization id") ?? idGenerator("org"),
      name: normalizeOrganizationName(input.name),
      createdAt: now(),
    };
    return repository.createOrganization(organization);
  }

  function createUser(input: CreateUserInput): User {
    const user: User = {
      id: optionalId(input.id, "user id") ?? idGenerator("usr"),
      email: normalizeUserEmail(input.email),
      ...(input.name === undefined ? {} : { name: normalizeUserName(input.name) }),
      createdAt: now(),
    };
    return repository.createUser(user);
  }

  function createProject(input: CreateProjectInput): Project {
    if (input.organizationId) {
      requireOrganization(repository, input.organizationId);
    }
    const project: Project = {
      id: optionalId(input.id, "project id") ?? idGenerator("prj"),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      name: normalizeProjectName(input.name),
      createdAt: now(),
    };
    return repository.createProject(project);
  }

  function addProjectMembership(input: AddProjectMembershipInput): ProjectMembership {
    requireProject(repository, input.projectId);
    requireUser(repository, input.userId);
    return repository.createProjectMembership({
      projectId: input.projectId,
      userId: input.userId,
      role: normalizeProjectRole(input.role),
      createdAt: now(),
    });
  }

  function listProjectMemberships(input: ListProjectMembershipsInput): ProjectMembership[] {
    requireProject(repository, input.projectId);
    return repository.listProjectMemberships(input.projectId);
  }

  function createApiKey(input: CreateApiKeyInput): CreateApiKeyOutput {
    const project = input.projectId ? requireProject(repository, input.projectId) : undefined;
    const organizationId = input.organizationId ?? project?.organizationId;
    if (organizationId) {
      requireOrganization(repository, organizationId);
    }
    if (!organizationId && !project) {
      throw new ControlPlaneError("validation", "api key requires organizationId or projectId");
    }
    const token = `wmp_${randomBytes(16).toString("hex")}`;
    const apiKey: ApiKey = {
      id: optionalId(input.id, "api key id") ?? idGenerator("key"),
      ...(organizationId ? { organizationId } : {}),
      ...(project ? { projectId: project.id } : {}),
      name: normalizeApiKeyName(input.name),
      scopes: normalizeApiScopes(input.scopes),
      createdAt: now(),
    };
    return {
      apiKey: repository.createApiKey(apiKey, hashApiToken(token)),
      token,
    };
  }

  function listProjectApiKeys(input: ListProjectApiKeysInput): ApiKey[] {
    requireProject(repository, input.projectId);
    return repository.listProjectApiKeys(input.projectId);
  }

  function authenticateApiToken(input: AuthenticateApiTokenInput): ApiToken | undefined {
    const token = typeof input.token === "string" ? input.token.trim() : "";
    if (token.length === 0) {
      return undefined;
    }
    const apiKey = repository.getApiKeyByTokenHash(hashApiToken(token));
    if (!apiKey || apiKey.revokedAt) {
      return undefined;
    }
    const used = repository.updateApiKeyLastUsed(apiKey.id, now());
    return {
      token,
      scopes: used.scopes,
      principal: `api-key:${used.id}`,
      apiKeyId: used.id,
      organizationId: used.organizationId,
      projectId: used.projectId,
    };
  }

  function recordUsageEvent(input: RecordUsageEventInput): UsageEvent {
    const project = requireProject(repository, input.projectId);
    const dimensions = normalizeUsageDimensions(input.dimensions);
    const metric = normalizeUsageMetricName(input.metric);
    const quantity = normalizeUsageQuantity(input.quantity);
    const recordedAt = normalizeUsageTimestamp(input.recordedAt, "usage recordedAt") ?? now();
    const event: UsageEvent = {
      id: optionalId(input.id, "usage event id") ?? idGenerator("use"),
      ...(project.organizationId ? { organizationId: project.organizationId } : {}),
      projectId: project.id,
      metric,
      quantity,
      ...(dimensions ? { dimensions } : {}),
      recordedAt,
    };
    const existing = repository.getUsageEvent(event.id);
    if (existing) {
      return resolveUsageEventReplay(event, existing);
    }
    enforceUsageQuota(project.id, event);
    enforceBillingBudget(project.id, event);
    try {
      return repository.createUsageEvent(event);
    } catch (error) {
      if (isConflictError(error)) {
        const raced = repository.getUsageEvent(event.id);
        if (raced) {
          return resolveUsageEventReplay(event, raced);
        }
      }
      throw error;
    }
  }

  function getProjectUsageSummary(input: GetProjectUsageSummaryInput): ProjectUsageSummary {
    requireProject(repository, input.projectId);
    const from = normalizeUsageTimestamp(input.from, "usage from");
    const to = normalizeUsageTimestamp(input.to, "usage to");
    if (from && to && Date.parse(from) >= Date.parse(to)) {
      throw new ControlPlaneError("validation", "usage from must be before usage to");
    }
    return repository.getProjectUsageSummary(input.projectId, from, to);
  }

  function getProjectEnforcementReport(input: GetProjectEnforcementReportInput): ProjectEnforcementReport {
    requireProject(repository, input.projectId);
    const from = normalizeUsageTimestamp(input.from, "enforcement report from");
    const to = normalizeUsageTimestamp(input.to, "enforcement report to");
    if (from && to && Date.parse(from) >= Date.parse(to)) {
      throw new ControlPlaneError("validation", "enforcement report from must be before to");
    }
    const summary = repository.getProjectUsageSummary(input.projectId, from, to);
    return createProjectEnforcementReport({
      summary,
      resources: repository.getProjectUsage(input.projectId),
      policy: projectEnforcementPolicies?.[input.projectId],
      generatedAt: now(),
    });
  }

  function getProjectUsageQuotaReport(input: GetProjectUsageQuotaReportInput): ProjectUsageQuotaReport {
    requireProject(repository, input.projectId);
    const at = normalizeUsageTimestamp(input.at, "usage quota at") ?? now();
    const policy = projectUsageQuotas?.[input.projectId];
    const period = usageQuotaPeriodFor(at, policy);
    const summary = repository.getProjectUsageSummary(input.projectId, period.from, period.to);
    return createProjectUsageQuotaReport({
      summary,
      period,
      policy,
      generatedAt: now(),
    });
  }

  function getProjectBillingStatement(input: GetProjectBillingStatementInput): ProjectBillingStatement {
    requireProject(repository, input.projectId);
    const at = normalizeUsageTimestamp(input.at, "billing statement at") ?? now();
    const period = usageQuotaPeriodFor(at, undefined);
    const summary = repository.getProjectUsageSummary(input.projectId, period.from, period.to);
    return createProjectBillingStatement({
      summary,
      period,
      rates: projectBillingRates,
      generatedAt: now(),
    });
  }

  function getProjectBillingBudgetReport(
    input: GetProjectBillingBudgetReportInput,
  ): ProjectBillingBudgetReport {
    requireProject(repository, input.projectId);
    const at = normalizeUsageTimestamp(input.at, "billing budget at") ?? now();
    const policy = projectBillingBudgets?.[input.projectId];
    const period = usageQuotaPeriodFor(at, policy);
    const summary = repository.getProjectUsageSummary(input.projectId, period.from, period.to);
    return createProjectBillingBudgetReport({
      summary,
      period,
      rates: projectBillingRates,
      policy,
      generatedAt: now(),
    });
  }

  function getOrganizationBillingStatement(
    input: GetOrganizationBillingStatementInput,
  ): OrganizationBillingStatement {
    requireOrganization(repository, input.organizationId);
    const at = normalizeUsageTimestamp(input.at, "billing statement at") ?? now();
    const period = usageQuotaPeriodFor(at, undefined);
    const summaries = repository
      .listOrganizationProjects(input.organizationId)
      .map((project) => repository.getProjectUsageSummary(project.id, period.from, period.to));
    return createOrganizationBillingStatement({
      organizationId: input.organizationId,
      summaries,
      period,
      rates: projectBillingRates,
      generatedAt: now(),
    });
  }

  function issueOrganizationBillingInvoice(
    input: IssueOrganizationBillingInvoiceInput,
  ): OrganizationBillingInvoice {
    requireOrganization(repository, input.organizationId);
    const at = normalizeUsageTimestamp(input.at, "billing invoice at") ?? now();
    const period = usageQuotaPeriodFor(at, undefined);
    const existing = repository.getOrganizationBillingInvoiceByPeriod(input.organizationId, period.key);
    if (existing) {
      return existing;
    }
    const summaries = repository
      .listOrganizationProjects(input.organizationId)
      .map((project) => repository.getProjectUsageSummary(project.id, period.from, period.to));
    const statement = createOrganizationBillingStatement({
      organizationId: input.organizationId,
      summaries,
      period,
      rates: projectBillingRates,
      generatedAt: now(),
    });
    const invoice = createOrganizationBillingInvoice({
      id: optionalId(input.id, "billing invoice id") ?? idGenerator("inv"),
      organizationId: input.organizationId,
      period,
      statement,
      rates: projectBillingRates,
      rateCardVersion: billingRateCardVersion,
      issuedAt: now(),
    });
    try {
      return repository.createBillingInvoice(invoice);
    } catch (error) {
      if (isConflictError(error)) {
        const raced = repository.getOrganizationBillingInvoiceByPeriod(input.organizationId, period.key);
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
  }

  function getBillingInvoice(input: GetBillingInvoiceInput): OrganizationBillingInvoice {
    const invoice = repository.getBillingInvoice(input.id);
    if (!invoice) {
      throw new ControlPlaneError("not_found", `billing invoice ${input.id} was not found`);
    }
    return invoice;
  }

  function listOrganizationBillingInvoices(
    input: ListOrganizationBillingInvoicesInput,
  ): OrganizationBillingInvoice[] {
    requireOrganization(repository, input.organizationId);
    return repository.listOrganizationBillingInvoices(input.organizationId);
  }

  function createCustomDomain(input: CreateCustomDomainInput): CustomDomain {
    requireProject(repository, input.projectId);
    const host = normalizeHost(input.host);
    const token = `wmpdv_${randomBytes(16).toString("hex")}`;
    const domain: CustomDomain = {
      id: optionalId(input.id, "custom domain id") ?? idGenerator("dom"),
      projectId: input.projectId,
      host,
      status: "pending_verification",
      verificationToken: token,
      verificationRecordName: customDomainVerificationRecordName(host),
      verificationRecordValue: customDomainVerificationRecordValue(token),
      tlsStatus: "none",
      createdAt: now(),
      updatedAt: now(),
    };
    return repository.createCustomDomain(domain);
  }

  function listProjectCustomDomains(input: ListProjectCustomDomainsInput): CustomDomain[] {
    requireProject(repository, input.projectId);
    return repository.listProjectCustomDomains(input.projectId);
  }

  function verifyCustomDomainOwnership(
    input: VerifyCustomDomainOwnershipInput,
  ): CustomDomain {
    const domain = requireCustomDomain(repository, input.id);
    const records = txtRecordValues(input.txtRecords);
    if (!records.includes(domain.verificationRecordValue)) {
      throw new ControlPlaneError(
        "validation",
        `custom domain ${domain.host} ownership TXT record was not found`,
      );
    }
    return repository.updateCustomDomain({
      ...domain,
      status: "verified",
      verifiedAt: now(),
      updatedAt: now(),
    });
  }

  function requestCustomDomainTlsProvisioning(
    input: RequestCustomDomainTlsProvisioningInput,
  ): CustomDomain {
    const domain = requireCustomDomain(repository, input.id);
    if (domain.status !== "verified" && domain.status !== "tls_failed" && domain.status !== "active") {
      throw new ControlPlaneError("validation", `custom domain ${domain.host} is not verified`);
    }
    return repository.updateCustomDomain({
      ...domain,
      status: "tls_pending",
      tlsStatus: "pending",
      ...(input.provider ? { tlsProvider: normalizeProvider(input.provider, "tls provider") } : {}),
      ...(input.requestId ? { tlsRequestId: normalizeProvider(input.requestId, "tls requestId") } : {}),
      tlsError: undefined,
      updatedAt: now(),
    });
  }

  function completeCustomDomainTlsProvisioning(
    input: CompleteCustomDomainTlsProvisioningInput,
  ): CustomDomain {
    const domain = requireCustomDomain(repository, input.id);
    if (typeof input.ok !== "boolean") {
      throw new ControlPlaneError("validation", "custom domain tls completion ok must be a boolean");
    }
    return repository.updateCustomDomain({
      ...domain,
      status: input.ok ? "active" : "tls_failed",
      tlsStatus: input.ok ? "provisioned" : "failed",
      ...(input.provider ? { tlsProvider: normalizeProvider(input.provider, "tls provider") } : {}),
      ...(input.requestId ? { tlsRequestId: normalizeProvider(input.requestId, "tls requestId") } : {}),
      tlsError: input.ok ? undefined : optionalNonEmpty(input.error, "tls error"),
      updatedAt: now(),
      ...(input.ok ? { tlsProvisionedAt: now() } : {}),
    });
  }

  function createDeployPreview(input: CreateDeployPreviewInput): DeployPreview {
    requireProject(repository, input.projectId);
    const deployment = requireDeployment(repository, input.deploymentId);
    if (deployment.projectId !== input.projectId) {
      throw new ControlPlaneError("validation", "deploy preview deployment must belong to the same project");
    }
    const host = normalizeHost(input.host ?? defaultDeployPreviewHost(input.projectId, input.deploymentId));
    const pathPrefix = normalizePathPrefix(input.pathPrefix ?? "/");
    const environment = normalizeDeployPreviewEnvironment(input.environment);
    enforceRouteCustomDomain(repository, input.projectId, host);
    const existingRoute = repository.getRoute(input.projectId, host, pathPrefix);
    if (!existingRoute) {
      enforceQuota(input.projectId, "route");
    }
    const preview: DeployPreview = {
      id: optionalId(input.id, "deploy preview id") ?? idGenerator("prv"),
      projectId: input.projectId,
      deploymentId: deployment.id,
      host,
      pathPrefix,
      url: deployPreviewUrl(host, pathPrefix),
      environment,
      status: "active",
      createdAt: now(),
      updatedAt: now(),
      ...(existingRoute ? { previousRoute: deployPreviewPreviousRoute(existingRoute) } : {}),
    };
    const route: RoutePointer = {
      id: existingRoute?.id ?? idGenerator("rte"),
      projectId: input.projectId,
      host,
      pathPrefix,
      deploymentId: deployment.id,
      targets: [{ deploymentId: deployment.id, weight: 100 }],
      updatedAt: now(),
    };
    repository.upsertRoute(route);
    return repository.createDeployPreview(preview);
  }

  function listProjectDeployPreviews(input: ListProjectDeployPreviewsInput): DeployPreview[] {
    requireProject(repository, input.projectId);
    return repository.listProjectDeployPreviews(input.projectId);
  }

  function rollbackDeployPreview(input: RollbackDeployPreviewInput): DeployPreview {
    const preview = requireDeployPreview(repository, input.id);
    if (preview.status === "rolled_back") {
      return preview;
    }
    if (preview.previousRoute) {
      repository.upsertRoute({
        id: preview.previousRoute.id,
        projectId: preview.projectId,
        host: preview.host,
        pathPrefix: preview.pathPrefix,
        deploymentId: preview.previousRoute.deploymentId,
        targets: preview.previousRoute.targets,
        updatedAt: now(),
      });
    } else {
      repository.deleteRoute(preview.projectId, preview.host, preview.pathPrefix);
    }
    return repository.updateDeployPreview({
      ...preview,
      status: "rolled_back",
      updatedAt: now(),
      rolledBackAt: now(),
    });
  }

  function createArtifact(input: CreateArtifactInput): Artifact {
    requireProject(repository, input.projectId);
    enforceQuota(input.projectId, "artifact");
    const artifact: Artifact = {
      id: optionalId(input.id, "artifact id") ?? idGenerator("art"),
      projectId: input.projectId,
      digest: normalizeDigest(input.digest),
      location: normalizeLocation(input.location),
      sizeBytes: normalizeSizeBytes(input.sizeBytes),
      signature: normalizeArtifactSignature(input.signature),
      provenance: normalizeArtifactProvenance(input.provenance),
      createdAt: now(),
    };
    enforceArtifactAdmissionPolicy(admissionPolicy, artifact);
    return repository.createArtifact(artifact);
  }

  function getProjectArtifactByDigest(input: GetProjectArtifactByDigestInput): Artifact | undefined {
    requireProject(repository, input.projectId);
    return repository.getArtifactByProjectDigest(input.projectId, normalizeDigest(input.digest));
  }

  function getProjectUsage(input: GetProjectUsageInput): ProjectResourceUsage {
    requireProject(repository, input.projectId);
    return repository.getProjectUsage(input.projectId);
  }

  function createSecret(input: CreateSecretInput): Secret {
    requireProject(repository, input.projectId);
    enforceQuota(input.projectId, "secret");
    const secret: Secret = {
      id: optionalId(input.id, "secret id") ?? idGenerator("sec"),
      projectId: input.projectId,
      name: normalizeSecretName(input.name),
      createdAt: now(),
      updatedAt: now(),
    };
    return repository.createSecret(secret, encodeSecretValue(normalizeSecretValue(input.value)));
  }

  function getSecret(input: GetSecretInput): Secret {
    return requireSecret(repository, input.id);
  }

  function listProjectSecrets(input: ListProjectSecretsInput): Secret[] {
    requireProject(repository, input.projectId);
    return repository.listProjectSecrets(input.projectId);
  }

  function updateSecretValue(input: UpdateSecretValueInput): Secret {
    requireSecret(repository, input.id);
    return repository.updateSecretValue(input.id, encodeSecretValue(normalizeSecretValue(input.value)), now());
  }

  function deleteSecret(input: DeleteSecretInput): void {
    requireSecret(repository, input.id);
    repository.deleteSecret(input.id);
  }

  function createKvNamespace(input: CreateKvNamespaceInput): KvNamespace {
    requireProject(repository, input.projectId);
    enforceQuota(input.projectId, "kv namespace");
    const namespace: KvNamespace = {
      id: optionalId(input.id, "kv namespace id") ?? idGenerator("kv"),
      projectId: input.projectId,
      name: normalizeKvNamespaceName(input.name),
      createdAt: now(),
      updatedAt: now(),
    };
    return repository.createKvNamespace(namespace);
  }

  function getKvNamespace(input: GetKvNamespaceInput): KvNamespace {
    return requireKvNamespace(repository, input.id);
  }

  function listProjectKvNamespaces(input: ListProjectKvNamespacesInput): KvNamespace[] {
    requireProject(repository, input.projectId);
    return repository.listProjectKvNamespaces(input.projectId);
  }

  function deleteKvNamespace(input: DeleteKvNamespaceInput): void {
    requireKvNamespace(repository, input.id);
    repository.deleteKvNamespace(input.id);
  }

  function createDeployment(input: CreateDeploymentInput): Deployment {
    requireProject(repository, input.projectId);
    enforceQuota(input.projectId, "deployment");
    const artifact = requireArtifact(repository, input.artifactId);
    if (artifact.projectId !== input.projectId) {
      throw new ControlPlaneError("validation", "deployment artifact must belong to the same project");
    }
    const capabilities = normalizeCapabilities(input.capabilities);
    const world = normalizeWorld(input.world);
    const worldVersion = workerWorldVersion(world);
    const runtime = normalizeRuntime(input.runtime);
    artifactSignatureVerifier?.verify(artifact);
    enforceDeploymentAdmissionPolicy(admissionPolicy, {
      artifact,
      world,
      worldVersion,
      runtime,
      capabilities,
    });
    requireDeploymentKvNamespaces(repository, input.projectId, capabilities);
    requireDeploymentSecrets(repository, input.projectId, capabilities);

    const deployment: Deployment = {
      id: optionalId(input.id, "deployment id") ?? idGenerator("dep"),
      projectId: input.projectId,
      artifactId: input.artifactId,
      world,
      worldVersion,
      runtime,
      limits: normalizeLimits(input.limits),
      capabilities,
      createdAt: now(),
    };
    return repository.createDeployment(deployment);
  }

  function pointRoute(input: PointRouteInput): RoutePointer {
    requireProject(repository, input.projectId);
    const targets = normalizeRouteTargets(input.targets, input.deploymentId);
    for (const target of targets) {
      const deployment = requireDeployment(repository, target.deploymentId);
      if (deployment.projectId !== input.projectId) {
        throw new ControlPlaneError("validation", "route deployment must belong to the same project");
      }
    }

    const host = normalizeHost(input.host);
    const pathPrefix = normalizePathPrefix(input.pathPrefix);
    enforceRouteCustomDomain(repository, input.projectId, host);
    if (!repository.getRoute(input.projectId, host, pathPrefix)) {
      enforceQuota(input.projectId, "route");
    }

    const route: RoutePointer = {
      id: optionalId(input.id, "route id") ?? idGenerator("rte"),
      projectId: input.projectId,
      host,
      pathPrefix,
      deploymentId: targets[0].deploymentId,
      targets,
      updatedAt: now(),
    };
    return repository.upsertRoute(route);
  }

  function startRouteCanary(input: StartRouteCanaryInput): RoutePointer {
    requireProject(repository, input.projectId);
    const host = normalizeHost(input.host);
    const pathPrefix = normalizePathPrefix(input.pathPrefix);
    const existing = requireRoute(repository, input.projectId, host, pathPrefix);
    const candidate = requireDeployment(repository, input.deploymentId);
    if (candidate.projectId !== input.projectId) {
      throw new ControlPlaneError("validation", "canary deployment must belong to the same project");
    }
    const stableDeploymentId = existing.targets[0]?.deploymentId ?? existing.deploymentId;
    if (stableDeploymentId === candidate.id) {
      throw new ControlPlaneError("validation", "canary deployment must differ from stable deployment");
    }
    const weight = canaryWeight(input.weight);
    return repository.upsertRoute({
      ...existing,
      deploymentId: stableDeploymentId,
      targets: [
        { deploymentId: stableDeploymentId, weight: 100 - weight },
        { deploymentId: candidate.id, weight },
      ],
      updatedAt: now(),
    });
  }

  function rollbackRoute(input: RollbackRouteInput): RoutePointer {
    requireProject(repository, input.projectId);
    const host = normalizeHost(input.host);
    const pathPrefix = normalizePathPrefix(input.pathPrefix);
    const existing = requireRoute(repository, input.projectId, host, pathPrefix);
    const deploymentId = input.deploymentId ?? existing.targets[0]?.deploymentId ?? existing.deploymentId;
    const deployment = requireDeployment(repository, deploymentId);
    if (deployment.projectId !== input.projectId) {
      throw new ControlPlaneError("validation", "rollback deployment must belong to the same project");
    }
    return repository.upsertRoute({
      ...existing,
      deploymentId,
      targets: [{ deploymentId, weight: 100 }],
      updatedAt: now(),
    });
  }

  function analyzeRouteCanary(input: AnalyzeRouteCanaryInput): AnalyzeRouteCanaryOutput {
    requireProject(repository, input.projectId);
    const host = normalizeHost(input.host);
    const pathPrefix = normalizePathPrefix(input.pathPrefix);
    const existing = requireRoute(repository, input.projectId, host, pathPrefix);
    const stableDeploymentId = existing.targets[0]?.deploymentId ?? existing.deploymentId;
    const candidate = requireDeployment(repository, input.candidateDeploymentId);
    if (candidate.projectId !== input.projectId) {
      throw new ControlPlaneError("validation", "canary deployment must belong to the same project");
    }
    if (!existing.targets.some((target) => target.deploymentId === candidate.id)) {
      throw new ControlPlaneError("validation", "canary deployment is not a target of the route");
    }

    const analysis = analyzeCanaryEvents(input.events, candidate.id, input.thresholds);
    const decision = repository.createCanaryDecision({
      id: idGenerator("can"),
      projectId: input.projectId,
      host,
      pathPrefix,
      stableDeploymentId,
      candidateDeploymentId: candidate.id,
      action: analysis.action,
      reason: analysis.reason,
      metrics: analysis.metrics,
      thresholds: input.thresholds,
      createdAt: now(),
    });
    const route = analysis.action === "rollback"
      ? repository.upsertRoute({
        ...existing,
        deploymentId: stableDeploymentId,
        targets: [{ deploymentId: stableDeploymentId, weight: 100 }],
        updatedAt: now(),
      })
      : existing;
    return { decision, route };
  }

  function createRouteSnapshot(): RouteSnapshot {
    const routes = repository.listRoutes().map((route) => {
      const targets = route.targets.map((target) => routeSnapshotTarget(target));
      const primary = targets[0];
      return {
        host: route.host,
        pathPrefix: route.pathPrefix,
        projectId: route.projectId,
        deploymentId: primary.deploymentId,
        targets,
        world: primary.world,
        worldVersion: primary.worldVersion,
        runtime: primary.runtime,
        limits: primary.limits,
        capabilities: primary.capabilities,
        artifact: routeSnapshotArtifact(primary.artifact),
      };
    });

    const generatedAt = now();
    return {
      id: snapshotId(generatedAt, routes),
      schemaVersion: 1,
      generatedAt,
      routes,
    };
  }

  function registerRuntimeNode(input: RegisterRuntimeNodeInput): RuntimeNode {
    const identity = normalizeRuntimeNodeIdentity(input.identity);
    const host = normalizeRuntimeNodeHostInfo(input.host);
    const node: RuntimeNode = {
      id: optionalId(input.id, "runtime node id") ?? idGenerator("rt"),
      url: normalizeRuntimeNodeUrl(input.url),
      status: normalizeRuntimeNodeStatus(input.status),
      registeredAt: now(),
      region: normalizeRuntimeNodeRegion(input.region),
      labels: normalizeRuntimeNodeLabels(input.labels),
      ...(identity ? { identity } : {}),
      ...(host ? { host } : {}),
    };
    return repository.createRuntimeNode(node);
  }

  function recordRuntimeNodeHeartbeat(input: RecordRuntimeNodeHeartbeatInput): RuntimeNode {
    const existing = repository.getRuntimeNode(input.id);
    if (!existing) {
      throw new ControlPlaneError("not_found", `runtime node ${input.id} was not found`);
    }
    const node: RuntimeNode = {
      ...existing,
      status: normalizeRuntimeNodeStatus(input.status),
      lastSeenAt: now(),
      version: input.version ?? existing.version,
      capacity: normalizeRuntimeNodeCapacity(input.capacity) ?? existing.capacity,
      load: normalizeRuntimeNodeLoad(input.load) ?? existing.load,
      identity: normalizeRuntimeNodeIdentity(input.identity) ?? existing.identity,
      host: normalizeRuntimeNodeHostInfo(input.host) ?? existing.host,
    };
    return repository.updateRuntimeNodeHeartbeat(node);
  }

  function updateRuntimeNodeStatus(input: UpdateRuntimeNodeStatusInput): RuntimeNode {
    return repository.updateRuntimeNodeStatus(input.id, normalizeRuntimeNodeStatus(input.status));
  }

  function cleanupRuntimeNodes(input: CleanupRuntimeNodesInput): CleanupRuntimeNodesOutput {
    const olderThanMs = cleanupOlderThanMs(input.olderThanMs);
    const statuses = cleanupStatuses(input.statuses);
    const cutoffMs = Date.parse(now()) - olderThanMs;
    const cutoff = new Date(cutoffMs).toISOString();
    const removed = repository.listRuntimeNodes().filter((node) =>
      statuses.has(node.status) && runtimeNodeObservedAtMs(node) < cutoffMs
    );
    for (const node of removed) {
      repository.deleteRuntimeNode(node.id);
    }
    return { cutoff, removed };
  }

  function listRuntimeNodes(): RuntimeNode[] {
    return repository.listRuntimeNodes();
  }

  function listActiveRuntimeNodes(): RuntimeNode[] {
    return repository.listRuntimeNodes().filter((node) => isActiveRuntimeNode(node, now(), runtimeNodeActiveTtlMs));
  }

  function recordRouteSnapshotPublication(
    input: RecordRouteSnapshotPublicationInput,
  ): RouteSnapshotPublication {
    return repository.createRouteSnapshotPublication({
      id: idGenerator("pub"),
      snapshotId: input.snapshotId,
      snapshotGeneratedAt: input.snapshotGeneratedAt,
      routes: input.routes,
      ok: input.ok,
      targets: input.targets,
      createdAt: now(),
    });
  }

  function listRouteSnapshotPublications(): RouteSnapshotPublication[] {
    return repository.listRouteSnapshotPublications();
  }

  function listCanaryDecisions(): CanaryDecision[] {
    return repository.listCanaryDecisions();
  }

  return {
    createOrganization,
    createUser,
    createProject,
    addProjectMembership,
    listProjectMemberships,
    createApiKey,
    listProjectApiKeys,
    authenticateApiToken,
    recordUsageEvent,
    getProjectUsageSummary,
    getProjectEnforcementReport,
    getProjectUsageQuotaReport,
    getProjectBillingStatement,
    getProjectBillingBudgetReport,
    getOrganizationBillingStatement,
    issueOrganizationBillingInvoice,
    getBillingInvoice,
    listOrganizationBillingInvoices,
    createCustomDomain,
    listProjectCustomDomains,
    verifyCustomDomainOwnership,
    requestCustomDomainTlsProvisioning,
    completeCustomDomainTlsProvisioning,
    createDeployPreview,
    listProjectDeployPreviews,
    rollbackDeployPreview,
    getProjectUsage,
    createArtifact,
    getProjectArtifactByDigest,
    createSecret,
    getSecret,
    listProjectSecrets,
    updateSecretValue,
    deleteSecret,
    createKvNamespace,
    getKvNamespace,
    listProjectKvNamespaces,
    deleteKvNamespace,
    createDeployment,
    pointRoute,
    startRouteCanary,
    analyzeRouteCanary,
    rollbackRoute,
    createRouteSnapshot,
    registerRuntimeNode,
    recordRuntimeNodeHeartbeat,
    updateRuntimeNodeStatus,
    cleanupRuntimeNodes,
    listRuntimeNodes,
    listActiveRuntimeNodes,
    recordRouteSnapshotPublication,
    listRouteSnapshotPublications,
    listCanaryDecisions,
  };

  function routeSnapshotTarget(target: RouteTarget) {
    const deployment = requireDeployment(repository, target.deploymentId);
    const artifact = requireArtifact(repository, deployment.artifactId);
    return {
      deploymentId: deployment.id,
      weight: target.weight,
      world: deployment.world,
      worldVersion: deployment.worldVersion,
      runtime: deployment.runtime,
      limits: deployment.limits,
      capabilities: deployment.capabilities,
      artifact: routeSnapshotArtifact(artifact),
    };
  }

  function routeSnapshotArtifact(artifact: Artifact) {
    return {
      id: artifact.id,
      digest: artifact.digest,
      location: artifact.location,
      ...(artifact.signature ? { signature: artifact.signature } : {}),
      ...(artifact.provenance ? { provenance: artifact.provenance } : {}),
    };
  }

  function encodeSecretValue(value: string): string {
    return secretCipher ? secretCipher.encrypt(value) : value;
  }

  function enforceQuota(projectId: string, resource: ProjectQuotaResource) {
    enforceProjectQuota(projectId, projectQuotas, repository.getProjectUsage(projectId), resource);
  }

  function enforceUsageQuota(projectId: string, event: UsageEvent) {
    const policy = projectUsageQuotas?.[projectId];
    if (!policy) {
      return;
    }
    const period = usageQuotaPeriodFor(event.recordedAt, policy);
    enforceProjectUsageQuota({
      projectId,
      policy,
      period,
      summary: repository.getProjectUsageSummary(projectId, period.from, period.to),
      metric: event.metric,
      quantity: event.quantity,
    });
  }

  function enforceBillingBudget(projectId: string, event: UsageEvent) {
    const policy = projectBillingBudgets?.[projectId];
    if (!policy) {
      return;
    }
    const period = usageQuotaPeriodFor(event.recordedAt, policy);
    enforceProjectBillingBudget({
      projectId,
      policy,
      period,
      summary: repository.getProjectUsageSummary(projectId, period.from, period.to),
      rates: projectBillingRates,
      metric: event.metric,
      quantity: event.quantity,
    });
  }
}

function resolveUsageEventReplay(event: UsageEvent, existing: UsageEvent): UsageEvent {
  if (sameUsageEvent(event, existing)) {
    return existing;
  }
  throw new ControlPlaneError(
    "conflict",
    `usage event ${event.id} already exists with different payload`,
  );
}

function sameUsageEvent(left: UsageEvent, right: UsageEvent): boolean {
  return left.id === right.id
    && left.organizationId === right.organizationId
    && left.projectId === right.projectId
    && left.metric === right.metric
    && left.quantity === right.quantity
    && left.recordedAt === right.recordedAt
    && JSON.stringify(left.dimensions ?? {}) === JSON.stringify(right.dimensions ?? {});
}

function isConflictError(error: unknown): boolean {
  return error instanceof ControlPlaneError && error.code === "conflict";
}

function normalizeBillingRateCardVersion(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    return "default";
  }
  if (normalized.length > 128) {
    throw new ControlPlaneError("validation", "billing rate card version must be 128 characters or fewer");
  }
  return normalized;
}

function isActiveRuntimeNode(
  node: RuntimeNode,
  nowValue: string,
  activeTtlMs: number | undefined,
): boolean {
  if (node.status !== "active") {
    return false;
  }
  if (activeTtlMs === undefined || !node.lastSeenAt) {
    return !isSaturatedRuntimeNode(node);
  }
  return Date.parse(nowValue) - Date.parse(node.lastSeenAt) <= activeTtlMs && !isSaturatedRuntimeNode(node);
}

function isSaturatedRuntimeNode(node: RuntimeNode): boolean {
  return Boolean(
    node.capacity
      && node.load
      && node.load.activeRequests >= node.capacity.concurrentRequests,
  );
}

function cleanupOlderThanMs(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new ControlPlaneError("validation", "runtime node cleanup olderThanMs must be a positive integer");
  }
  return value as number;
}

function cleanupStatuses(value: unknown): Set<RuntimeNodeStatus> {
  if (value === undefined) {
    return new Set(["offline"]);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new ControlPlaneError("validation", "runtime node cleanup statuses must be a non-empty array");
  }
  return new Set(value.map((status) => normalizeRuntimeNodeStatus(status)));
}

function runtimeNodeObservedAtMs(node: RuntimeNode): number {
  return Date.parse(node.lastSeenAt ?? node.registeredAt);
}

function requireOrganization(repository: ControlPlaneRepository, id: string): Organization {
  const organization = repository.getOrganization(id);
  if (!organization) {
    throw new ControlPlaneError("not_found", `organization ${id} was not found`);
  }
  return organization;
}

function requireUser(repository: ControlPlaneRepository, id: string): User {
  const user = repository.getUser(id);
  if (!user) {
    throw new ControlPlaneError("not_found", `user ${id} was not found`);
  }
  return user;
}

function requireProject(repository: ControlPlaneRepository, id: string): Project {
  const project = repository.getProject(id);
  if (!project) {
    throw new ControlPlaneError("not_found", `project ${id} was not found`);
  }
  return project;
}

function requireCustomDomain(repository: ControlPlaneRepository, id: string): CustomDomain {
  const domain = repository.getCustomDomain(id);
  if (!domain) {
    throw new ControlPlaneError("not_found", `custom domain ${id} was not found`);
  }
  return domain;
}

function requireDeployPreview(repository: ControlPlaneRepository, id: string): DeployPreview {
  const preview = repository.getDeployPreview(id);
  if (!preview) {
    throw new ControlPlaneError("not_found", `deploy preview ${id} was not found`);
  }
  return preview;
}

function enforceRouteCustomDomain(
  repository: ControlPlaneRepository,
  projectId: string,
  host: string,
) {
  const domain = repository.getCustomDomainByHost(host);
  if (!domain) {
    return;
  }
  if (domain.projectId !== projectId) {
    throw new ControlPlaneError("validation", `custom domain ${host} is owned by another project`);
  }
  if (domain.status !== "active") {
    throw new ControlPlaneError("validation", `custom domain ${host} is not active`);
  }
}

function requireArtifact(repository: ControlPlaneRepository, id: string): Artifact {
  const artifact = repository.getArtifact(id);
  if (!artifact) {
    throw new ControlPlaneError("not_found", `artifact ${id} was not found`);
  }
  return artifact;
}

function requireSecret(repository: ControlPlaneRepository, id: string): Secret {
  const secret = repository.getSecret(id);
  if (!secret) {
    throw new ControlPlaneError("not_found", `secret ${id} was not found`);
  }
  return secret;
}

function requireKvNamespace(repository: ControlPlaneRepository, id: string): KvNamespace {
  const namespace = repository.getKvNamespace(id);
  if (!namespace) {
    throw new ControlPlaneError("not_found", `kv namespace ${id} was not found`);
  }
  return namespace;
}

function requireDeploymentKvNamespaces(
  repository: ControlPlaneRepository,
  projectId: string,
  capabilities: CapabilityPolicy,
) {
  for (const binding of capabilities.kv) {
    const namespace = repository.getKvNamespace(binding.namespaceId);
    if (!namespace) {
      throw new ControlPlaneError("validation", `kv namespace ${binding.namespaceId} was not found`);
    }
    if (namespace.projectId !== projectId) {
      throw new ControlPlaneError(
        "validation",
        `deployment kv namespace ${binding.namespaceId} must belong to the same project`,
      );
    }
  }
}

function requireDeploymentSecrets(
  repository: ControlPlaneRepository,
  projectId: string,
  capabilities: CapabilityPolicy,
) {
  for (const binding of capabilities.secrets) {
    const secret = repository.getSecret(binding.secretId);
    if (!secret) {
      throw new ControlPlaneError("validation", `secret ${binding.secretId} was not found`);
    }
    if (secret.projectId !== projectId) {
      throw new ControlPlaneError(
        "validation",
        `deployment secret ${binding.secretId} must belong to the same project`,
      );
    }
  }
}

function requireDeployment(repository: ControlPlaneRepository, id: string): Deployment {
  const deployment = repository.getDeployment(id);
  if (!deployment) {
    throw new ControlPlaneError("not_found", `deployment ${id} was not found`);
  }
  return deployment;
}

function requireRoute(
  repository: ControlPlaneRepository,
  projectId: string,
  host: string,
  pathPrefix: string,
): RoutePointer {
  const route = repository.getRoute(projectId, host, pathPrefix);
  if (!route) {
    throw new ControlPlaneError("not_found", `route ${host}${pathPrefix} was not found`);
  }
  return route;
}

function canaryWeight(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 99) {
    throw new ControlPlaneError("validation", "canary weight must be an integer between 1 and 99");
  }
  return value as number;
}

function defaultIdGenerator(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function hashApiToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function customDomainVerificationRecordName(host: string): string {
  return `_wasmplane-challenge.${host}`;
}

function customDomainVerificationRecordValue(token: string): string {
  return `wasmplane-domain-verification=${token}`;
}

function txtRecordValues(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ControlPlaneError("validation", "custom domain txtRecords must be an array");
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new ControlPlaneError("validation", "custom domain txtRecords must be strings");
    }
    return item.trim();
  });
}

function normalizeDeployPreviewEnvironment(value: unknown): DeployPreviewEnvironment {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlPlaneError("validation", "deploy preview environment must be an object");
  }
  const environment: DeployPreviewEnvironment = {};
  for (const [key, bindingValue] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new ControlPlaneError("validation", "deploy preview environment binding keys must be env var names");
    }
    if (typeof bindingValue !== "string") {
      throw new ControlPlaneError("validation", `deploy preview environment binding ${key} must be a string`);
    }
    if (bindingValue.length > 4096 || /[\u0000]/.test(bindingValue)) {
      throw new ControlPlaneError(
        "validation",
        `deploy preview environment binding ${key} must be a string up to 4096 characters`,
      );
    }
    environment[key] = bindingValue;
  }
  return environment;
}

function deployPreviewPreviousRoute(route: RoutePointer): DeployPreviewPreviousRoute {
  return {
    id: route.id,
    deploymentId: route.deploymentId,
    targets: route.targets,
    updatedAt: route.updatedAt,
  };
}

function deployPreviewUrl(host: string, pathPrefix: string): string {
  return `https://${host}${pathPrefix}`;
}

function defaultDeployPreviewHost(projectId: string, deploymentId: string): string {
  return `${dnsLabel(deploymentId)}.${dnsLabel(projectId)}.preview.wasmplane.local`;
}

function dnsLabel(value: string): string {
  const label = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return label.slice(0, 63) || "preview";
}

function normalizeProvider(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ControlPlaneError("validation", `${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 120 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ControlPlaneError("validation", `${field} must be a printable string up to 120 characters`);
  }
  return normalized;
}

function optionalNonEmpty(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return normalizeProvider(value, field);
}

function snapshotId(generatedAt: string, routes: RouteSnapshot["routes"]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ generatedAt, routes }))
    .digest("hex")
    .slice(0, 16);
  return `snap_${digest}`;
}
