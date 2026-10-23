// An error that carries a text key and values for the message shown to the user,
// and the exit code the command should end with.
export class CliError extends Error {
  constructor(key, params = {}, exitCode = 2) {
    super(key);
    this.name = 'CliError';
    this.key = key;
    this.params = params;
    this.exitCode = exitCode;
  }
}
