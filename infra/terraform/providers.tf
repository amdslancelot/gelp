# The OCI provider is configured entirely from variables (see variables.tf)
# rather than from the OCI CLI config file (~/.oci/config), so that this
# configuration is portable and its credentials are explicit and injectable
# via terraform.tfvars or environment variables (TF_VAR_*).
provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}
