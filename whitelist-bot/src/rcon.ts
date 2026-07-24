// Thin RCON transport: connect per command, send, disconnect.

import { Rcon } from 'rcon-client';

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

export interface RconCommandRunner {
  run(command: string): Promise<string>;
}

export class RconClient implements RconCommandRunner {
  constructor(private readonly options: RconOptions) {}

  /** Runs one console command and returns the server's textual reply. */
  async run(command: string): Promise<string> {
    const rcon = await Rcon.connect({
      host: this.options.host,
      port: this.options.port,
      password: this.options.password,
      timeout: this.options.timeoutMs ?? 10_000,
    });
    try {
      return await rcon.send(command);
    } finally {
      await rcon.end().catch(() => undefined);
    }
  }
}
