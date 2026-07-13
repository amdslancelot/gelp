# Gelp deploy webhook

This directory configures [`adnanh/webhook`](https://github.com/adnanh/webhook)
(v2.8+, required for the `payload-hmac-sha256` match type) to run
`/opt/gelp/deploy/deploy.sh` whenever GitHub pushes to `main`. The systemd
service that runs `webhook -hooks /opt/gelp/deploy/webhook/hooks.json -port
9000` is set up by the server's cloud-init, not by this repo.

## `{{WEBHOOK_SECRET}}` placeholder

`hooks.json` contains a `{{WEBHOOK_SECRET}}` placeholder in place of the real
HMAC secret. Replace it with a real secret value (for example the output of
`openssl rand -hex 32`) in the copy of this file that actually gets loaded by
the `webhook` systemd service on the server; do not commit the real secret to
this repository.

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
