# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose API keys, execute unintended commands, or access private files. Use GitHub's private vulnerability reporting feature for this repository instead.

Include the affected version, a minimal reproduction, impact, and any suggested mitigation. Do not include real credentials or personal data.

## Secret handling

Forge stores local configuration and runtime state under `.agent-data/`, which is excluded from Git. Provider keys can also be supplied through environment variables. Never place a real key in source files, screenshots, issues, logs, or test fixtures.
