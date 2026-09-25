# federal-regulations-mcp-server - Directory Structure

Generated on: 2026-09-25 09:28:09

```text
federal-regulations-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   ├── tool-defs-analysis/
│   │   └── SKILL.md
│   └── README.md
├── scripts/
│   ├── _mirror-context.ts
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── ecfr-mirror-init.ts
│   ├── ecfr-mirror-refresh.ts
│   ├── ecfr-mirror-verify.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── cfr-section.resource.ts
│   │   │       ├── document.resource.ts
│   │   │       └── index.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── browse-cfr.tool.ts
│   │           ├── date-input.ts
│   │           ├── document-number.ts
│   │           ├── find-comments.tool.ts
│   │           ├── format-utils.ts
│   │           ├── get-cfr-section.tool.ts
│   │           ├── get-docket.tool.ts
│   │           ├── get-document.tool.ts
│   │           ├── index.ts
│   │           ├── list-open-comments.tool.ts
│   │           ├── paging.ts
│   │           └── search-rules.tool.ts
│   ├── services/
│   │   ├── ecfr/
│   │   │   ├── cite.ts
│   │   │   ├── ecfr-service.ts
│   │   │   ├── read-section.ts
│   │   │   ├── types.ts
│   │   │   └── xml.ts
│   │   ├── ecfr-mirror/
│   │   │   ├── ecfr-mirror.ts
│   │   │   └── refresh-job.ts
│   │   ├── federal-register/
│   │   │   ├── federal-register-service.ts
│   │   │   └── types.ts
│   │   ├── regulations-gov/
│   │   │   ├── regulations-gov-service.ts
│   │   │   └── types.ts
│   │   ├── character-references.ts
│   │   ├── request-budget.ts
│   │   ├── text-window.ts
│   │   └── upstream-failure.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   ├── ecfr-14-241-25.xml
│   │   ├── ecfr-40-141.61.xml
│   │   ├── ecfr-search-lead-service-line-t40.json
│   │   ├── ecfr-structure-40-parts-50-141.json
│   │   ├── ecfr-structure-42-part-22.json
│   │   ├── ecfr-structure-7-part-1955.json
│   │   └── ecfr-title-3-2024-05-17.xml
│   ├── helpers/
│   │   └── handler-context.ts
│   ├── resources/
│   │   └── resources.test.ts
│   ├── scripts/
│   │   └── lint-packaging.test.ts
│   ├── services/
│   │   ├── character-references.test.ts
│   │   ├── ecfr-mirror.test.ts
│   │   ├── ecfr-service.test.ts
│   │   ├── ecfr-xml.test.ts
│   │   ├── federal-register-service.test.ts
│   │   ├── read-section.test.ts
│   │   ├── refresh-job.test.ts
│   │   ├── regulations-gov-service.test.ts
│   │   └── request-budget.test.ts
│   ├── tools/
│   │   ├── browse-cfr.contract.test.ts
│   │   ├── browse-cfr.tool.test.ts
│   │   ├── error-contracts.test.ts
│   │   ├── federal-register-contract.test.ts
│   │   ├── find-comments.tool.test.ts
│   │   ├── format-utils.test.ts
│   │   ├── get-cfr-section.contract.test.ts
│   │   ├── get-cfr-section.tool.test.ts
│   │   ├── get-docket.tool.test.ts
│   │   ├── get-document-full-text.test.ts
│   │   ├── get-document.tool.test.ts
│   │   ├── list-open-comments-window.test.ts
│   │   ├── list-open-comments.tool.test.ts
│   │   ├── paging.test.ts
│   │   └── search-rules.tool.test.ts
│   └── tsconfig-coverage.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
