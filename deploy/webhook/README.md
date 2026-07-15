# Gelp deploy webhook

This directory configures [`adnanh/webhook`](https://github.com/adnanh/webhook)
(v2.8+, required for the `payload-hmac-sha256` match type) to run
`/opt/gelp/deploy/deploy.sh` whenever GitHub pushes to `main`. The systemd
service that runs `webhook -hooks /etc/webhook/hooks.json -port 9000` is
installed by `deploy/setup-server.sh`; it runs against the *rendered* copy
at `/etc/webhook/hooks.json` (real secret substituted in), never against
the checked-in template here.

## `{{WEBHOOK_SECRET}}` placeholder

`hooks.json` contains a `{{WEBHOOK_SECRET}}` placeholder in place of the real
HMAC secret. You normally don't touch it: `deploy/setup-server.sh`
substitutes the `WEBHOOK_SECRET` value you pass it and writes the result to
`/etc/webhook/hooks.json` on the server. Only if you set a server up without
that script do you substitute a real secret (for example the output of
`openssl rand -hex 32`) into the copy the `webhook` service loads — never
into this checked-in file; the real secret must not be committed.

## Configuring the GitHub webhook

In the GitHub repository, go to **Settings → Webhooks → Add webhook** and set:

- **Payload URL**: `http://<server-ip>:9000/hooks/deploy`
- **Content type**: `application/json`
- **Secret**: the same value substituted for `{{WEBHOOK_SECRET}}` above
- **Which events**: "Just the push event" is sufficient; `hooks.json` already
  filters to `refs/heads/main` on the server side.

Once saved, GitHub will sign every delivery with `X-Hub-Signature-256` using
the shared secret; `webhook` verifies that signature and the branch ref
before invoking `deploy.sh`, so any request that doesn't match both checks is
ignored.
