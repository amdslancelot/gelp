#cloud-config
# Cloud-init for the Gelp host: a single Ubuntu 22.04 ARM64 instance running
# Docker + k3s. This file is rendered by Terraform's templatefile() function
# (see compute.tf) and passed to the instance as base64-encoded user_data.
#
# IMPORTANT for maintainers: this is a Terraform template, not a plain
# cloud-config file. Any doubled-up dollar-brace sequence below is an
# ESCAPED literal that must survive templatefile() and reach the instance
# as a literal single dollar-brace sequence for the shell/systemd to
# interpret (e.g. shell variable expansion, systemd specifiers). Anywhere
# you see a single, non-doubled dollar-brace sequence, it is a real
# Terraform interpolation of one of the values passed in from compute.tf.

package_update: true
package_upgrade: false

packages:
  - docker.io
  - git
  - curl
  - jq

write_files:
  # deploy.env is read by /opt/gelp/deploy/deploy.sh per the shared
  # contract. It is written before the first deploy run below.
  - path: /opt/gelp-bootstrap/deploy.env
    owner: root:root
    permissions: "0600"
    content: |
      GELP_HOST=${gelp_host}
      LETSENCRYPT_EMAIL=${letsencrypt_email}
      KUBECONFIG=/etc/rancher/k3s/k3s.yaml

  # The webhook secret is staged here (root-only) so the runcmd step below
  # can sed it into the rendered hooks.json without ever writing the plain
  # secret into shell history or process listings.
  - path: /opt/gelp-bootstrap/webhook.secret
    owner: root:root
    permissions: "0600"
    content: |
      ${webhook_secret}

  # systemd unit for adnanh/webhook, per the shared contract: it must run
  # against the *rendered* hooks.json (with the real secret substituted
  # in), not the checked-in template that still has the {{WEBHOOK_SECRET}}
  # placeholder.
  - path: /etc/systemd/system/webhook.service
    owner: root:root
    permissions: "0644"
    content: |
      [Unit]
      Description=adnanh/webhook listener for Gelp push-to-deploy
      After=network-online.target k3s.service
      Wants=network-online.target

      [Service]
      Type=simple
      ExecStart=/usr/local/bin/webhook -hooks /etc/webhook/hooks.json -port 9000 -verbose
      Restart=always
      RestartSec=5
      User=root

      [Install]
      WantedBy=multi-user.target

runcmd:
  # --- Docker -----------------------------------------------------------
  - systemctl enable --now docker

  # --- k3s ----------------------------------------------------------------
  # Official install script; runs k3s as a systemd service (k3s.service)
  # with the default Traefik ingress controller and local-path storage
  # provisioner left enabled, per the contract.
  - curl -sfL https://get.k3s.io | sh -
  - >-
    for i in $(seq 1 60); do
      if /usr/local/bin/k3s kubectl get nodes 2>/dev/null | grep -q ' Ready ';
      then break; fi;
      echo "waiting for k3s node to be Ready ($${i}/60)...";
      sleep 5;
    done
  # Make kubectl/KUBECONFIG usable for non-interactive root shells (deploy.sh
  # also sets KUBECONFIG itself via deploy.env, this just covers ad-hoc use).
  - mkdir -p /root/.kube
  - ln -sf /etc/rancher/k3s/k3s.yaml /root/.kube/config
  - chmod 600 /etc/rancher/k3s/k3s.yaml

  # --- clone the app repo --------------------------------------------------
  - mkdir -p /opt/gelp
  - >-
    if [ ! -d /opt/gelp/.git ]; then
      git clone --branch main --depth 1 ${repo_url} /opt/gelp;
    fi

  # --- deploy.env -----------------------------------------------------------
  - install -o root -g root -m 0600 /opt/gelp-bootstrap/deploy.env /opt/gelp/deploy.env

  # --- webhook binary -------------------------------------------------------
  # adnanh/webhook v2.8.1, linux-arm64 build, matching the A1.Flex (ARM64)
  # host architecture.
  - >-
    curl -sfL -o /tmp/webhook.tar.gz
    https://github.com/adnanh/webhook/releases/download/2.8.1/webhook-linux-arm64.tar.gz
  - mkdir -p /tmp/webhook-extract
  - tar -xzf /tmp/webhook.tar.gz -C /tmp/webhook-extract
  - install -o root -g root -m 0755 /tmp/webhook-extract/webhook-linux-arm64/webhook /usr/local/bin/webhook
  - rm -rf /tmp/webhook.tar.gz /tmp/webhook-extract

  # --- render hooks.json from the checked-in template ----------------------
  # deploy/webhook/hooks.json (owned by the deploy agent) ships with the
  # literal placeholder "{{WEBHOOK_SECRET}}"; substitute in the real secret
  # here and write the result to /etc/webhook/hooks.json, which is what the
  # webhook.service unit above actually runs against. The checked-in file
  # itself is never modified.
  - mkdir -p /etc/webhook
  - >-
    if [ -f /opt/gelp/deploy/webhook/hooks.json ]; then
      sed "s/{{WEBHOOK_SECRET}}/$(cat /opt/gelp-bootstrap/webhook.secret)/g"
      /opt/gelp/deploy/webhook/hooks.json > /etc/webhook/hooks.json;
    else
      echo "WARNING: /opt/gelp/deploy/webhook/hooks.json not found; webhook will not start correctly" >&2;
      echo '[]' > /etc/webhook/hooks.json;
    fi
  - chmod 600 /etc/webhook/hooks.json
  - rm -f /opt/gelp-bootstrap/webhook.secret

  # --- start the webhook listener ------------------------------------------
  - systemctl daemon-reload
  - systemctl enable --now webhook.service

  # --- first deploy ---------------------------------------------------------
  # This is expected to fail gracefully the very first time: the gelp-env
  # Kubernetes Secret does not exist yet, and deploy.sh prints instructions
  # for creating it rather than hard-failing. We do not want a non-zero
  # exit code here to mark the whole cloud-init run as failed, so the
  # actual invocation is wrapped with "|| true".
  - mkdir -p /var/log
  - >-
    if [ -f /opt/gelp/deploy/deploy.sh ]; then
      bash /opt/gelp/deploy/deploy.sh 2>&1 | tee /var/log/gelp-first-deploy.log || true;
    else
      echo "deploy/deploy.sh not present yet at first boot; skipping first deploy" | tee /var/log/gelp-first-deploy.log;
    fi
