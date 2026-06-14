# federal-regulations-mcp-server - Directory Structure

Generated on: 2026-06-14 01:15:22

```text
federal-regulations-mcp-server/
├── .claude/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.yml
│       ├── config.yml
│       └── feature_request.yml
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── data/
├── docs/
│   ├── design.md
│   └── idea.md
├── scripts/
│   ├── _mirror-context.ts
│   ├── build-changelog.ts
│   ├── build.ts
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
├── skills/
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
│   └── tool-defs-analysis/
│       └── SKILL.md
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
│   │           ├── find-comments.tool.ts
│   │           ├── format-utils.ts
│   │           ├── get-cfr-section.tool.ts
│   │           ├── get-docket.tool.ts
│   │           ├── get-document.tool.ts
│   │           ├── index.ts
│   │           ├── list-open-comments.tool.ts
│   │           └── search-rules.tool.ts
│   ├── services/
│   │   ├── ecfr/
│   │   │   ├── ecfr-service.ts
│   │   │   ├── types.ts
│   │   │   └── xml.ts
│   │   ├── ecfr-mirror/
│   │   │   └── ecfr-mirror.ts
│   │   ├── federal-register/
│   │   │   ├── federal-register-service.ts
│   │   │   └── types.ts
│   │   ├── regulations-gov/
│   │   │   ├── regulations-gov-service.ts
│   │   │   └── types.ts
│   │   └── request-context.ts
│   └── index.ts
├── tests/
│   ├── resources/
│   │   └── resources.test.ts
│   ├── services/
│   │   ├── ecfr-service.test.ts
│   │   ├── ecfr-xml.test.ts
│   │   ├── federal-register-service.test.ts
│   │   └── regulations-gov-service.test.ts
│   └── tools/
│       ├── browse-cfr.tool.test.ts
│       ├── find-comments.tool.test.ts
│       ├── get-cfr-section.tool.test.ts
│       ├── get-docket.tool.test.ts
│       ├── get-document.tool.test.ts
│       ├── list-open-comments.tool.test.ts
│       └── search-rules.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── CHANGELOG.md
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
