# ADR: Account graph relationship canonicalization

Date: 2026-05-21
Status: accepted for Phase A.6 planning

## Context

Phase A.5 added an evidence-first account graph foundation with `AccountObject`, `Claim`, `ClaimEvidence`, `EvidenceExcerpt`, `SourceDocument`, `GraphEdge`, and `ConflictRecord` primitives.

Before Phase A.6 backfill work, we need to decide which relationships are represented as embedded references and which relationships are represented as first-class graph edges. Without this decision, future contributors may relitigate whether `AccountObject.claim_ids` duplicates `GraphEdge(kind="relates_to")`, and query/index design will drift.

## Decision

Use both patterns, but for different relationship classes:

1. Embedded references are canonical for containment/high-frequency provenance traversals.
   - `AccountObject.claim_ids` is the canonical object → claim containment link.
   - `ClaimEvidence.claim_id` + `ClaimEvidence.evidence_excerpt_id` is the canonical claim → evidence link.
   - `EvidenceExcerpt.source_document_id` is the canonical excerpt → source link.

2. `GraphEdge` is canonical for semantic/lower-frequency relationships.
   - claim contradicts claim
   - claim supports claim
   - claim depends on claim
   - object relates to object
   - signal/risk/opportunity relationships that are not containment
   - future cascade/dependency links that need explanation/rationale

3. Do not use `GraphEdge` to duplicate every containment link by default.
   - A.6 may derive reverse indexes for query speed, but those indexes are implementation details, not new canonical sources of truth.

## Rationale

Embedded references make the common read path cheap and obvious:

- render an object with its supporting claims
- render a claim with its supporting excerpts
- validate that visible account intelligence is grounded
- compute provenance fanout from known containment chains

Graph edges make semantic relationships uniform and explainable without overloading containment fields:

- contradictions
- support/dependency relationships
- cross-object relationships
- future impact/cascade relationships

This matches the pattern most knowledge-graph systems converge on: containment/provenance links stay close to the record they explain, while semantic relationships become explicit edge records.

## Rejected alternatives

### All relationships as `GraphEdge`

Pros:
- uniform traversal model
- symmetric reverse queries
- fewer relationship-specific fields

Cons:
- common object → claims and claim → evidence reads require extra joins/traversals
- easy to overproduce noisy edges
- less ergonomic for deterministic backfill and validation

Rejected because A.6 needs simple, inspectable backfill from existing `brief_json` more than it needs a fully generic graph engine.

### All relationships as embedded arrays

Pros:
- simple JSON shape
- cheap direct traversal from parent records

Cons:
- reverse queries are harder
- contradictions and support relationships become ad hoc fields
- relationship rationale/provenance has no durable home

Rejected because semantic relationships need first-class records with rationale and future auditability.

### Duplicate containment links as both embedded references and `GraphEdge`

Pros:
- convenient for some graph traversal tools

Cons:
- two sources of truth
- validator complexity
- drift risk

Rejected for Phase A.6. If a future storage engine needs derived graph edges for performance, they should be generated indexes, not canonical authoring fields.

## Consequences for A.6

- Backfill should populate `AccountObject.claim_ids`, `ClaimEvidence`, and `EvidenceExcerpt.source_document_id` as the primary provenance chain.
- `GraphEdge` should only be emitted when there is a semantic relationship worth preserving with `kind` and `rationale`.
- Validators should treat embedded containment references as required integrity links.
- Validators should treat graph edges as semantic links whose endpoints must exist, but not require an edge for every containment relationship.
- Report/query code may build reverse indexes in memory for convenience.
