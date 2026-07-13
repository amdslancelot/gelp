# Pin the Terraform CLI and provider versions so that `terraform init` is
# reproducible across machines and over time. The OCI provider is pulled
# from the public Terraform Registry (registry.terraform.io); no OCI
# credentials are required for `init`, only for `plan`/`apply`.

terraform {
  required_version = ">= 1.5"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }
}
