import { exec } from "./util";
import fetch from "node-fetch";
import { parse_json_stream } from "json-stream";
import * as vscode from "vscode";

/**
 * The metadata of a cargo workspace.
 * See https://doc.rust-lang.org/cargo/reference/external-tools.html#cargo-metadata
 */
export interface Metadata {
  packages: Package[];
  resolve: Resolve | null;
  workspace_members: string[];
  target_directory: string;
  version: number;
  workspace_root: string;
}

/**
 * A package in the workspace.
 */
export class Package {
  constructor(
    public id: string,
    public name: string,
    public description: string,
    public version: string,
    public source: string,
    public dependencies: Dependency[]
  ) {}

  // Make a TreeItem for this package.
  public toTreeItem(): CargoTreeItem {
    return new PackageTreeItem(this);
  }
}

/**
 * A dependency of a package.
 */
export class Dependency {
  constructor(
    public name: string,
    public source: string,
    public kind: string
  ) {}

  public toTreeItem(): CargoTreeItem {
    return new DependencyTreeItem(this);
  }
}

/**
 * The dependency graph of a cargo workspace.
 */
export interface Resolve {
  nodes: Node[];
  root: string;
}

/**
 * A node in the dependency graph.
 */
export interface Node {
  id: string;
  dependencies: string[];
  features: string[];
}

export type Diagnostic = MessageDiagnostic | {};

export interface MessageDiagnostic {
  message: Message;
}

export interface Message {
  children: Message[];
  code: Code | null;
  level: Level;
  message: string;
  rendered: string | null;
  spans: Span[];
}

export interface Code {
  code: string;
  explanation: string;
}

export enum Level {
  Error = "error",
  Help = "help",
  Note = "note",
  Warning = "warning",
}

export interface Span {
  file_name: string;
  line_end: number;
  line_start: number;
  column_start: number;
  column_end: number;
  byte_end: number;
  byte_start: number;
  is_primary: boolean;
  label: string | null;
  // expansion: ???
  // suggested_replacement: ???
  // text: …
}

export async function metadata(cwd: string): Promise<Metadata> {
  let output = await exec(
    "cargo",
    ["metadata", "--no-deps", "--format-version=1"],
    { cwd }
  );

  if (output.code !== 0) {
    throw new Error(`cargo build: ${output.stderr}`);
  }

  return JSON.parse(output.stdout);
}

export async function build(cwd: string): Promise<Diagnostic[]> {
  let output = await exec("cargo", ["build", "--message-format=json"], { cwd });

  if (output.code !== 0 && output.stdout === "") {
    throw new Error(`cargo build: ${output.stderr}`);
  }

  return parse_json_stream(output.stdout);
}

export async function check(cwd: string): Promise<Diagnostic[]> {
  let output = await exec(
    "cargo",
    ["check", "--message-format=json", "--all-targets"],
    { cwd }
  );

  if (output.code !== 0 && output.stdout === "") {
    throw new Error(`cargo check: ${output.stderr}`);
  }

  return parse_json_stream(output.stdout);
}

export async function add(cwd: string, pkg: string) {
  let { code, stderr } = await exec("cargo", ["add", "--", pkg], { cwd });

  if (code !== 0) {
    console.error(stderr);
    throw Error("`cargo add` returned with non-zero exit code");
  }
}

export async function rm(cwd: string, pkg: string) {
  let { code, stderr } = await exec("cargo", ["rm", "--", pkg], { cwd });

  if (code !== 0) {
    console.error(stderr);
    throw Error("`cargo rm` returned with non-zero exit code");
  }
}

export async function search(name: string): Promise<SearchResult[]> {
  let response = await fetch(
    `https://crates.io/api/v1/crates?per_page=20&q=${name}`
  );
  let json = (await response.json()) as { crates: SearchResult[] };

  return json.crates;
}

export interface SearchResult {
  name: string;
  description: string;
  max_version: string;
  downloads: number;
  recent_downloads: number;
}

export class CargoTreeItem extends vscode.TreeItem {}

export class PackageTreeItem extends CargoTreeItem {
  constructor(public pkg: Package) {
    super(pkg.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = pkg.version;
    this.tooltip = pkg.description;
  }
}

export class DependencyTreeItem extends CargoTreeItem {
  constructor(public dep: Dependency) {
    super(dep.name, vscode.TreeItemCollapsibleState.None);
    this.description = dep.kind;
    this.tooltip = dep.source;
  }
}

/**
 * A tree data provider for cargo workspaces.
 * 
 * Translates between Metadata and vscode.TreeItem.
 */
export class CargoTreeDataProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private _onDidChangeTreeData: vscode.EventEmitter<
    vscode.TreeItem | undefined
  > = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> =
    this._onDidChangeTreeData.event;
  private packages: Map<string, Package> = new Map();

  /**
   * Initialize the metadata
   * @param metadata The metadata to load.
   */
  loadMetadata(metadata: Metadata): void {
    this.packages.clear();
    metadata.packages.forEach((pkg) => {
      this.packages.set(pkg.id, pkg);
    });
  }

  constructor(private metadata: Metadata) {
    this.loadMetadata(metadata);
  }

  refresh(): void {
    this.loadMetadata(this.metadata);
    this._onDidChangeTreeData.fire(undefined);
  }

  getChildren(
    element?: vscode.TreeItem | undefined
  ): vscode.ProviderResult<vscode.TreeItem[]> {
    // If we're at the root, show the workspace members.
    if (!element) {
      const root_ids = this.metadata.workspace_members;
      const roots = root_ids.map((id) => this.packages.get(id)!);
      return roots.map((pkg) => pkg.toTreeItem());
    }

    // If we're at a package, show its dependencies.
    if (element instanceof PackageTreeItem) {
      const pkg = this.packages.get(element.pkg.id)!;
      return pkg.dependencies.map((dep) => dep.toTreeItem());
    }

    // Otherwise, we're at a dependency, so we have no children.
    return [];
  }

  getTreeItem(element: CargoTreeItem): vscode.TreeItem {
    return element;
  }
}
