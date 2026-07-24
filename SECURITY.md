# Security Policy

Cove is a local-first, end-to-end-encrypted notes app. Your notes, tasks and
attachments are encrypted with AES-256-GCM under a key wrapped by your passphrase
(scrypt); plaintext and keys never touch disk and never leave your machine unless
you explicitly export or sync them. See the **Security model** section of the
[README](README.md) for details.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** rather than opening a public
issue:

- Use GitHub's **[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)**
  (Security → Report a vulnerability on this repository), or
- open a minimal public issue that says only "security report — please provide a
  private contact" (no details), and wait to be contacted.

Please include, where possible: affected version, a description of the issue, and
steps to reproduce. We aim to acknowledge reports within a few days.

## Scope

In scope: the server (`server.js`, `lib/`), the web client (`public/`), the
crypto and storage layers, and anything that could expose plaintext, keys, or
another user's data.

Out of scope: issues that require an attacker who already has your unlocked
device or your passphrase; the security of third-party cloud-sync providers you
choose to store the encrypted data directory in; and transcription/webhook
endpoints you deliberately point at external services.

## Supported versions

This is a single, actively developed line of releases; fixes land on the latest
version. Please update to the latest code before reporting.
