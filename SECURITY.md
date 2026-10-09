# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Report it privately:

- on GitHub: this repository's **Security** tab → **Report a vulnerability**;
- or by email to **support@genter.ai**, with "Security" in the subject.

Say what is affected (`genter --version`, the command or the MCP tool), how to reproduce it, and what an attacker
gains. We confirm that we received it and keep you posted until it is fixed. This covers the `genter` command, its MCP
server and its library; a vulnerability in Genter Cloud (genter.ai) is reported the same way.

## Supported versions

The latest release on npm. A fix comes out as a new version: run `npx genter-cli@latest` or update the package.

## What Genter promises

What a report can be held against:

- **What it reads.** Text and code files of the folders you add (the current folder on the first `ask`), public
  websites you add, and its notes file. Never hidden files, files the folder's `.gitignore` ignores, lockfiles, keys
  and credentials (`id_rsa`, `*.pem`, `*.key`, `credentials.json`, …), or any file holding a private key.
- **Websites.** Public addresses only: an address that resolves to a private or local network is refused.
- **What it stores.** In `~/.genter` (or `GENTER_HOME`): which places there are, their digests, headings and dates, a
  page's most frequent words and the vectors of `--semantic`, sealed with AES-256-GCM and a secret made on the first
  run. Never the text of a file or a page. Its files there (the config with that secret, your keys and a Genter Cloud
  token, and the sealed stores) are readable by their owner only.
- **What it sends.** With no key, nothing. With `--semantic`, the passages to rank go to the embeddings provider you
  chose. Signed in with `genter login`, your questions go to Genter Cloud. The app commands call Composio and
  OpenRouter with your keys.
- **What it runs.** Nothing it reads. A skill's scripts are handed over, never run.
