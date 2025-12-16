import * as vscode from "vscode";

// Private static output channel shared by all logger instances
let singletonOutputChannel: vscode.OutputChannel | null = null;

/**
 * Logger class for the extension.
 * It provides a singleton output channel for all log messages.
 * It also provides a named logger instance for each feature.
 */
export class Logger implements vscode.Disposable {
  private static getOutputChannel(): vscode.OutputChannel {
    if (!singletonOutputChannel) {
      singletonOutputChannel = vscode.window.createOutputChannel("Bazel");
    }
    return singletonOutputChannel;
  }

  /**
   * Creates a new named Logger instance
   * @param name The name of the logger instance
   */
  constructor(private readonly name: string) {}

  /**
   * Show the output channel for the logger
   */
  public static show(): void {
    Logger.getOutputChannel().show();
  }

  public debug(message: string): void {
    this.log("DEBUG", message);
  }

  public info(message: string): void {
    this.log("INFO", message);
  }

  public warn(message: string): void {
    this.log("WARN", message);
  }

  public error(message: string): void {
    this.log("ERROR", message);
  }

  private log(level: string, message: string): void {
    const outputChannel = Logger.getOutputChannel();
    outputChannel.appendLine(this.formatMessage(level, message));
  }

  private formatMessage(level: string, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] [${this.name}] ${message}`;
  }

  public dispose(): void {
    // Don't dispose the output channel here as it's shared
  }

  /**
   * Call this when the extension is deactivated to clean up the shared resource
   */
  public static disposeAll(): void {
    if (singletonOutputChannel) {
      singletonOutputChannel.dispose();
      singletonOutputChannel = null;
    }
  }
}
