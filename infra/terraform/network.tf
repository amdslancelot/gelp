# Minimal single-AZ network: one VCN, one public subnet, an internet
# gateway, and a security list that opens exactly the ports the contract
# requires (SSH, HTTP, HTTPS, and the push-to-deploy webhook listener).

resource "oci_core_vcn" "gelp" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.0.0.0/16"]
  display_name   = "gelp-vcn"
  dns_label      = "gelpvcn"
}

resource "oci_core_internet_gateway" "gelp" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.gelp.id
  display_name   = "gelp-igw"
  enabled        = true
}

resource "oci_core_route_table" "gelp" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.gelp.id
  display_name   = "gelp-public-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.gelp.id
  }
}

# A single security list allowing inbound 22 (SSH), 80/443 (HTTP/HTTPS via
# Traefik), and 9000 (adnanh/webhook, for GitHub push-to-deploy), plus
# unrestricted egress. There is deliberately no separate NSG: this is a
# single-instance personal project, so a subnet-level security list is
# simpler to reason about than per-resource network security groups.
resource "oci_core_security_list" "gelp" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.gelp.id
  display_name   = "gelp-public-sl"

  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }

  ingress_security_rules {
    protocol = "6" # TCP
    source   = "0.0.0.0/0"
    tcp_options {
      min = 22
      max = 22
    }
  }

  ingress_security_rules {
    protocol = "6" # TCP
    source   = "0.0.0.0/0"
    tcp_options {
      min = 80
      max = 80
    }
  }

  ingress_security_rules {
    protocol = "6" # TCP
    source   = "0.0.0.0/0"
    tcp_options {
      min = 443
      max = 443
    }
  }

  ingress_security_rules {
    protocol = "6" # TCP
    source   = "0.0.0.0/0"
    tcp_options {
      min = 9000
      max = 9000
    }
  }
}

resource "oci_core_subnet" "gelp_public" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.gelp.id
  cidr_block                 = "10.0.1.0/24"
  display_name               = "gelp-public-subnet"
  dns_label                  = "gelppublic"
  route_table_id             = oci_core_route_table.gelp.id
  security_list_ids          = [oci_core_security_list.gelp.id]
  prohibit_public_ip_on_vnic = false
}
