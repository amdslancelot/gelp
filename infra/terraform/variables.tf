# ---------------------------------------------------------------------------
# OCI API authentication (see https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm)
# ---------------------------------------------------------------------------

variable "tenancy_ocid" {
  description = "OCID of the OCI tenancy (root compartment) that owns the account."
  type        = string
}

variable "user_ocid" {
  description = "OCID of the OCI user whose API signing key is used for authentication."
  type        = string
}

variable "fingerprint" {
  description = "Fingerprint of the uploaded API signing key, as shown in the OCI console under the user's API keys."
  type        = string
}

variable "private_key_path" {
  description = "Local filesystem path to the PEM-encoded private key that matches the fingerprint above."
  type        = string
}

variable "region" {
  description = "OCI region identifier to deploy into, e.g. \"us-ashburn-1\". Must be a region where an Always Free A1.Flex shape is available."
  type        = string
}

# ---------------------------------------------------------------------------
# Placement
# ---------------------------------------------------------------------------

variable "compartment_ocid" {
  description = "OCID of the compartment in which to create the VCN, subnet, and compute instance."
  type        = string
}

variable "availability_domain" {
  description = "Availability domain name to launch the instance in, e.g. \"AbCd:US-ASHBURN-AD-1\". Leave as the empty string to automatically pick the first availability domain available in the compartment/region."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Instance shape
# ---------------------------------------------------------------------------

variable "instance_shape" {
  description = "Compute shape for the instance. The Always Free tier offers up to 4 OCPUs / 24 GB total across A1.Flex instances."
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "instance_ocpus" {
  description = "Number of OCPUs to allocate to the flexible shape."
  type        = number
  default     = 4
}

variable "instance_memory_gb" {
  description = "Amount of memory, in GB, to allocate to the flexible shape."
  type        = number
  default     = 24
}

# ---------------------------------------------------------------------------
# SSH access
# ---------------------------------------------------------------------------

variable "ssh_authorized_key" {
  description = "Public SSH key (contents of e.g. ~/.ssh/id_ed25519.pub) that will be authorized to log in to the instance as the default \"ubuntu\" user."
  type        = string
}

# ---------------------------------------------------------------------------
# Application / deploy configuration (consumed by cloud-init and passed
# through to /opt/gelp/deploy.env and the webhook unit, per the contract
# with deploy/deploy.sh and deploy/webhook/hooks.json).
# ---------------------------------------------------------------------------

variable "repo_url" {
  description = "HTTPS URL of the GitHub repository to clone to /opt/gelp on first boot, e.g. https://github.com/you/gelp.git. The \"main\" branch is checked out."
  type        = string
}

variable "gelp_host" {
  description = "Public DNS hostname under which the app will be served (e.g. gelp.example.com). Written to deploy.env as GELP_HOST and used by cert-manager for the TLS certificate."
  type        = string
}

variable "letsencrypt_email" {
  description = "Email address passed to cert-manager/Let's Encrypt for expiry and abuse notifications. Written to deploy.env as LETSENCRYPT_EMAIL."
  type        = string
}

variable "webhook_secret" {
  description = "Shared secret used to authenticate GitHub push webhook deliveries. Substituted into the rendered /etc/webhook/hooks.json in place of the literal {{WEBHOOK_SECRET}} placeholder found in deploy/webhook/hooks.json. Configure the same value as the secret on the GitHub webhook."
  type        = string
  sensitive   = true
}
