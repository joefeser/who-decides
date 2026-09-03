# Pre-existing Work Disclosure

Per the Agents for Humans hackathon rules, this project was newly created during
the submission period (August 10 – September 14, 2026), and all pre-existing work
incorporated into it is disclosed here.

## Incorporated pre-existing work

| Work | License | How it's used here |
| --- | --- | --- |
| [HACP](https://github.com/joefeser/hacp) — Human-Approved Coordination Protocol (public spec repo by the same author, predating this hackathon) | Prose: CC BY 4.0 · machine-readable artefacts: Apache-2.0 | Conceptual foundation (typed task packets, decision gates, stop reasons, agent reports). Selected JSON Schemas from its `schemas/` directory are copied into this repo under `schemas/` with attribution, and the demo validates its artifacts against them. |
| [Strands Agents SDK](https://github.com/strands-agents) (AWS) | Apache-2.0 | Agent runtime: agents, tools, sessions. |
| Other libraries listed in `package.json` | per package | Standard open-source dependencies. |

## Attribution

HACP schema files retain their upstream headers where present. The HACP
specification text is cited under CC BY 4.0; copies of machine-readable HACP
artefacts are redistributed under Apache-2.0 per the upstream repository's
license split.

## What is new in this repository

All application code, the demo workflow, the decision console, documentation,
and the integration between Strands and the HACP-shaped artifacts are written
during the hackathon submission period.
