output "instance_public_ip" {
  description = "Public IPv4 address of the Gelp host."
  value       = oci_core_instance.gelp.public_ip
}

output "webhook_url" {
  description = "URL to register as the GitHub webhook delivery target (Payload URL) for push-to-deploy."
  value       = "http://${oci_core_instance.gelp.public_ip}:9000/hooks/deploy"
}

output "next_steps" {
  description = "Manual steps required after `terraform apply` to finish bringing Gelp online."
  value       = <<-EOT
    1. Point the DNS "A" record for ${var.gelp_host} at ${oci_core_instance.gelp.public_ip}.
    2. SSH in (ssh ubuntu@${oci_core_instance.gelp.public_ip}) and create the app secret,
       since deploy.sh will not have created it on its own:
         kubectl create namespace gelp --dry-run=client -o yaml | kubectl apply -f -
         kubectl -n gelp create secret generic gelp-env --from-env-file=/path/to/your/.env
    3. In the GitHub repo settings, add a webhook with:
         Payload URL:  http://${oci_core_instance.gelp.public_ip}:9000/hooks/deploy
         Content type: application/json
         Secret:       the same value you set for webhook_secret in terraform.tfvars
       so that pushes to main trigger /opt/gelp/deploy/deploy.sh via the webhook listener.
    4. Re-run the first deploy once the secret exists, if it failed the first time:
         ssh ubuntu@${oci_core_instance.gelp.public_ip} 'sudo bash /opt/gelp/deploy/deploy.sh'
  EOT
}
