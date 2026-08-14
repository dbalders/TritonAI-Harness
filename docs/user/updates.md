# TritonAI updates

TritonAI uses separate update paths so routine changes do not require rerunning the full Installer.

- **Harness application:** use **Settings > About > Check for Updates**. A Harness update also carries UCSD-managed configuration, built-in skills, and the managed plugin composition.
- **Managed Codex CLI:** TritonAI checks the installed Codex provider version. When an update is available, use the provider update action in the sidebar or provider settings. The update is staged, verified, activated transactionally, and checked again by Harness.
- **Managed secure skills:** when a Harness release configures the authenticated secure-skills endpoint, Harness checks it at startup and on the configured polling interval. Only skills owned by the managed-skills manifest are replaced.
- **Public and community skills:** the catalog refreshes automatically. Installed copies remain user-controlled; remove and add a skill again to refresh its installed copy.
- **Managed Node.js runtime:** use the full TritonAI Installer when Node must change or when the managed runtime needs repair.

If a Codex update cannot run on the current managed Node.js version, no staged update is activated. Run the latest full Installer to update or repair the managed runtime, then retry from Harness.
