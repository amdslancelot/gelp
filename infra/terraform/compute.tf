# Picks the first availability domain in the compartment/region unless the
# caller pins one explicitly via var.availability_domain.
data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_ocid
}

locals {
  availability_domain = var.availability_domain != "" ? var.availability_domain : data.oci_identity_availability_domains.ads.availability_domains[0].name
}

# Latest Canonical Ubuntu 22.04 image built for aarch64 (ARM64), matching
# the A1.Flex shape's architecture. oci_core_images sorts results by
# time_created descending by default, so the first entry is the newest.
data "oci_core_images" "ubuntu_arm" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "22.04"
  shape                    = var.instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

locals {
  # Guard against the image list including non-aarch64 builds by filtering
  # on the image display name, which Canonical's published Ubuntu images
  # consistently suffix with "aarch64" for ARM builds.
  ubuntu_arm_images = [
    for img in data.oci_core_images.ubuntu_arm.images : img
    if length(regexall("(?i)aarch64", img.display_name)) > 0
  ]
  ubuntu_arm_image_id = length(local.ubuntu_arm_images) > 0 ? local.ubuntu_arm_images[0].id : data.oci_core_images.ubuntu_arm.images[0].id
}

resource "oci_core_instance" "gelp" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  display_name        = "gelp-host"
  shape               = var.instance_shape

  shape_config {
    ocpus         = var.instance_ocpus
    memory_in_gbs = var.instance_memory_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.gelp_public.id
    assign_public_ip = true
    display_name     = "gelp-host-vnic"
  }

  source_details {
    source_type = "image"
    source_id   = local.ubuntu_arm_image_id
  }

  metadata = {
    ssh_authorized_keys = var.ssh_authorized_key
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tpl", {
      repo_url          = var.repo_url
      gelp_host         = var.gelp_host
      letsencrypt_email = var.letsencrypt_email
      webhook_secret    = var.webhook_secret
    }))
  }

  # The Always Free A1.Flex allocation is capacity-constrained in some
  # regions/ADs; preserve the instance across unrelated plan/apply cycles
  # and require an explicit taint/destroy to actually replace it.
  lifecycle {
    create_before_destroy = false
  }
}
