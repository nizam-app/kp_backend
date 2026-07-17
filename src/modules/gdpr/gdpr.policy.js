/**
 * Declarative data retention policy served to admins via
 * GET /admin/gdpr/retention-policy. Kept dependency-free so it can be
 * unit-tested and referenced without loading runtime config.
 */
export const DATA_RETENTION_POLICY = Object.freeze({
  version: "1.0",
  lastReviewed: "2026-07-17",
  controller: "Platform operator (admin team)",
  principles: [
    "Personal data is kept only as long as needed for the purpose it was collected for.",
    "Financial records (jobs, invoices, disputes) are retained to meet legal and accounting obligations, even after account erasure.",
    "Erasure anonymizes the subject: identifiers are removed while non-personal operational records are preserved.",
    "Admin actions on personal data (export, erasure) are always written to the audit log.",
  ],
  categories: [
    {
      key: "account",
      dataCategory: "Account & profile data",
      description: "Email, name, phone, addresses, profile photos, preferences.",
      retentionPeriod: "Life of the account; anonymized immediately on GDPR erasure.",
      legalBasis: "Contract performance",
      erasureBehavior: "Anonymized (email and profile PII replaced with placeholders).",
    },
    {
      key: "jobs",
      dataCategory: "Jobs & quotes",
      description: "Service requests, quotes, job events and status history.",
      retentionPeriod: "6 years after completion (service and warranty records).",
      legalBasis: "Legal obligation / legitimate interest",
      erasureBehavior: "Retained; linked user record is anonymized.",
    },
    {
      key: "financial",
      dataCategory: "Invoices & payments",
      description: "Invoices, payment method references (masked), payout records.",
      retentionPeriod: "6 years (tax and accounting law).",
      legalBasis: "Legal obligation",
      erasureBehavior:
        "Invoices retained; payment methods deactivated and billing addresses redacted.",
    },
    {
      key: "communications",
      dataCategory: "Chat messages & support tickets",
      description: "Job chat messages, attachments, support conversations.",
      retentionPeriod: "2 years after last activity.",
      legalBasis: "Legitimate interest (dispute resolution)",
      erasureBehavior: "Message text and attachments redacted on erasure.",
    },
    {
      key: "notifications",
      dataCategory: "Notifications & device tokens",
      description: "In-app notifications, push device tokens.",
      retentionPeriod: "90 days (notifications); life of session (device tokens).",
      legalBasis: "Consent / legitimate interest",
      erasureBehavior: "Deleted on erasure.",
    },
    {
      key: "audit",
      dataCategory: "Admin audit logs",
      description: "Records of admin actions, including GDPR export and erasure events.",
      retentionPeriod: "6 years.",
      legalBasis: "Legal obligation (accountability)",
      erasureBehavior: "Retained; contains admin actor labels, not subject PII.",
    },
  ],
});
