# Gelp infrastructure (Terraform / OCI)

This directory provisions the single Always Free `VM.Standard.A1.Flex`
instance that runs Gelp: Ubuntu 22.04 ARM64 with Docker and k3s (default
Traefik ingress, local-path storage), bootstrapped end-to-end via cloud-init.

## Prerequisites

- An Oracle Cloud Infrastructure (OCI) account with Always Free resources
  available in your home region (A1.Flex capacity can be constrained; retry
  `terraform apply` if you hit an "Out of host capacity" error).
- An OCI API signing key pair, with the public key uploaded to your user in
  the OCI console (Identity -> Users -> your user -> API Keys). You will need
  the tenancy OCID, user OCID, key fingerprint, and the private key's local
  path.
- An SSH key pair to log in to the instance (any `ssh-ed25519` or `ssh-rsa`
  public key).
- The `gelp` repository pushed to GitHub (or another git host reachable over
  HTTPS from the instance), since cloud-init clones it into `/opt/gelp`.
- Terraform >= 1.5 installed locally.

## Usage

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars with your real OCIDs, keys, hostnames, and secrets
terraform init
terraform apply
```

`terraform apply` creates a VCN, a public subnet, an internet gateway, a
security list opening ports 22/80/443/9000, and the compute instance itself.
On first boot the instance's cloud-init:

1. Installs Docker, k3s (Traefik ingress + local-path storage included by
   default), git, curl, and jq.
2. Clones `repo_url` (the `main` branch) to `/opt/gelp`.
3. Writes `/opt/gelp/deploy.env` with `GELP_HOST`, `LETSENCRYPT_EMAIL`, and
   `KUBECONFIG=/etc/rancher/k3s/k3s.yaml`.
4. Installs the `adnanh/webhook` v2.8.1 binary, renders
   `/opt/gelp/deploy/webhook/hooks.json` (replacing the `{{WEBHOOK_SECRET}}`
   placeholder with your real `webhook_secret`) into `/etc/webhook/hooks.json`,
   and starts it as a systemd service listening on port 9000.
5. Runs `/opt/gelp/deploy/deploy.sh` once. This first run is expected to only
   partially succeed, because the `gelp-env` Kubernetes secret does not exist
   yet (see step 2 below) — `deploy.sh` is designed to print instructions and
   exit gracefully in that case rather than fail hard.

## Post-apply steps

After `terraform apply` finishes, `terraform output` prints the instance's
public IP, a ready-made webhook URL, and a `next_steps` block. In short:

1. **DNS**: point an `A` record for your `gelp_host` at the printed
   `instance_public_ip`.
2. **App secret**: SSH into the instance and create the `gelp-env` Kubernetes
   secret in the `gelp` namespace (the exact keys depend on what the app
   needs — see the app's `.env.example`), then re-run
   `sudo bash /opt/gelp/deploy/deploy.sh` if the first automatic run didn't
   fully complete.
3. **GitHub webhook**: in the GitHub repo's Settings -> Webhooks, add the
   `webhook_url` output as the Payload URL, content type
   `application/json`, and the same secret as `webhook_secret` in your
   `terraform.tfvars`, so that pushes to `main` trigger a redeploy.

## Notes / judgment calls

- Only ports 22, 80, 443, and 9000 are opened to the internet, per the
  shared contract; everything else stays on the instance's loopback/cluster
  network.
- The Ubuntu image is selected dynamically via `oci_core_images`, filtered to
  the `22.04` OS version and `aarch64` in the display name, and sorted so the
  newest matching image is used — there is no hardcoded image OCID, since
  those are region-specific and rotate over time.
- `terraform.tfvars` is expected to be gitignored (it holds real credentials
  and the webhook secret); only `terraform.tfvars.example` is checked in.
