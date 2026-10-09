# Security policy

qa-conductor boots a pull request's code and signs a reviewer in to it, so a hole in its defences can hand someone the reviewer's machine, sessions or tokens. Please report one privately.

## Supported versions

Only the latest 0.x release gets security fixes. A fix ships as a new release; earlier versions aren't patched, so upgrade to get it (read the [CHANGELOG](CHANGELOG.md) for any migration).

| Version | Supported |
|---|---|
| the latest 0.x release | yes |
| anything older | no |

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: on this repository's **Security** tab, choose **Report a vulnerability**. Please don't open a public issue, pull request or discussion about it.

If the **Security** tab has no **Report a vulnerability** button, open an issue titled "Security contact request" that says only that you have something to report, with nothing about what or where. A maintainer will open a private security advisory, add you to it, and take the report there.

A useful report says:
- the version, and the layout: `QA_EXPOSURE`, the front door, and which built-in adapters you run;
- what gets through: the request, page or PR that does, and what it reaches;
- how to reproduce it, as briefly as you can.

Responses are best effort: this is a small project, with no security team and no response deadline. We'll tell you what we find, agree a disclosure date with you, and credit you in the advisory unless you'd rather not be named.

## Scope

In scope is any way around one of the defences the README's [Security](README.md#security) section describes:
- **the identity gate**: in tailscale mode, a request to the harness or a pane that is served without an allowed `Tailscale-User-Login`;
- **the trust gate** in `adapters/build-worktree`: a PR's code checked out, installed or run although its author, or where its head lives, fails the gate, or a SHA other than the one the gate passed;
- **the request guards**: the `Host` allowlist, the harness API's same-origin and harness-origin checks, its JSON-only writes, and the pane request guard;
- **the framing rules**: another page framing the harness, or a pane outside the harness origin and `QA_FRAME_ANCESTORS`, or driving a pane's mirror bridge;
- **cookie isolation**: a pane app that gets a cookie other than its own jar's and the ones `QA_FORWARD_CLIENT_COOKIES` names, or a cookie an earlier session's app set;
- **token handling**: `GITHUB_QA_TOKEN`, `QA_GHCR_TOKEN` or the conductor's own environment reaching a pane's process, a page, a log line or the verdict comment;
- **pane isolation** in `adapters/provisioner-docker`, on Docker Engine with its default iptables rules: the PR pane's containers reaching the base pane's other than through the host ([Known limits](README.md#known-limits)), or one pane's generated database password reaching the other pane ([its section](README.md#built-in-adaptersprovisioner-docker-docker-provisioner)).

Out of scope are the limits the README already states, such as PR code that passes the trust gate running as the reviewer, the panes' pages sharing the browser's cookies with other apps on their hostname, and the other [known limits](README.md#known-limits); flaws in a consumer's own adapters or front door; and denial of service by someone the gate lets in.
