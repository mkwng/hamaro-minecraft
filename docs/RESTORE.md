# RESTORE — getting a world back

Backups are plain `.tar.gz` files in `s3://hamaro-minecraft-<acct>/backups/<profile>/`,
taken automatically on every auto-sleep, every 2 h while running, and before every
world switch / settings apply. Older ones migrate to cheaper storage tiers
(after ~4 months they're in Deep Archive — restores from there need a
[12-hour S3 retrieval](https://docs.aws.amazon.com/AmazonS3/latest/userguide/restoring-objects.html) first).

## Easy path (website)

Admin → Backups → select one → type a target profile name → Restore.
Target can be the same profile (roll back) or a new name (fork the world).
The previous data is kept at `data.pre-restore` inside the profile dir — one level of undo.

## Manual path (website dead, AWS fine)

```bash
aws ssm start-session --target <instance-id> --region us-west-2
sudo /opt/hamaro/restore.sh backups/survival/survival-20260705T031500Z.tar.gz survival
```

## Disaster path (everything dead except S3)

The tarball contains `data/` (the whole itzg server dir: world, configs, plugins) and
`profile.env`. Any machine with Docker can run it:

```bash
aws s3 cp s3://hamaro-minecraft-<acct>/backups/survival/<latest>.tar.gz .
tar -xzf <latest>.tar.gz
docker run -d -p 25565:25565 --env-file profile.env -e EULA=TRUE \
  -v "$PWD/data:/data" itzg/minecraft-server:<tag>
```

That's the whole recovery story. As long as the S3 bucket (or even one downloaded
tarball) exists, the kids' worlds are safe.
