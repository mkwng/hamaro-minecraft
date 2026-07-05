#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { CONFIG } from "../lib/config";
import { GameStack } from "../lib/game-stack";
import { WebStack } from "../lib/web-stack";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

new GameStack(app, "HamaroGame", {
  env: { account, region: CONFIG.gameRegion },
  description: "Hamaro Minecraft: game server, DNS, control API, safety nets",
});

new WebStack(app, "HamaroWeb", {
  env: { account, region: CONFIG.webRegion },
  description: "Hamaro Minecraft: control website (hamaro.rowan.wang)",
});
