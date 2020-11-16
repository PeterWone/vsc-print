import * as vscode from 'vscode';
import * as hljs from "highlight.js";
import * as http from "http";
import * as child_process from "child_process";
import * as fs from "fs";
import { AddressInfo } from 'net';

var md: any;
var commandArgs: any;
var selection: vscode.Selection | undefined;
const browserLaunchMap: any = { darwin: "open", linux: "xdg-open", win32: "start" };
export function activate(context: vscode.ExtensionContext) {
  let ecmPrint = vscode.workspace.getConfiguration("print", null).editorContextMenuItemPosition,
    etmButton = vscode.workspace.getConfiguration("print", null).editorTitleMenuButton;
  vscode.commands.executeCommand("setContext", "ecmPrint", ecmPrint);
  vscode.commands.executeCommand("setContext", "etmButton", etmButton);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(checkConfigurationChange));
  let disposable = vscode.commands.registerCommand("extension.print", async (cmdArgs: any) => {
    commandArgs = cmdArgs;
    let editor = vscode.window.activeTextEditor;
    selection = editor && editor.selection ? editor.selection : undefined;
    await startWebserver();
    let printConfig = vscode.workspace.getConfiguration("print", null);
    let cmd = printConfig.alternateBrowser && printConfig.browserPath ? `"${printConfig.browserPath}"` : browserLaunchMap[process.platform];
    child_process.exec(`${cmd} http://localhost:${port}/`);
  });
  context.subscriptions.push(disposable);
  disposable = vscode.commands.registerCommand('extension.browse', async (cmdArgs: any) => {
    commandArgs = cmdArgs;
    let x = vscode.extensions.getExtension("pdconsec.vscode-print");
    if (!x) { throw new Error("Cannot resolve extension. Has the name changed? It is defined by the publisher and the extension name defined in package.json"); }
    var styleCachePath = `${x.extensionPath.replace(/\\/g, "/")}/node_modules/highlight.js/styles`;
    let printConfig = vscode.workspace.getConfiguration("print", null);
    let currentPath = `${styleCachePath}/${printConfig.colourScheme}.css`;
    vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(fs.existsSync(currentPath) ? currentPath : styleCachePath),
      filters: {
        Stylesheet: ['css']
      }
    }).then(f => {
      if (f) {
        let p = f[0].fsPath.replace(/\\/g, "/");
        let lastSlashPosition = p.lastIndexOf("/");
        let extensionSeparatorPosition = p.lastIndexOf(".");
        if (extensionSeparatorPosition === -1) {
          extensionSeparatorPosition = p.length;
        }
        var path = p.substring(0, lastSlashPosition);
        var fileName = p.substring(lastSlashPosition + 1, extensionSeparatorPosition);
        try {
          vscode.workspace.getConfiguration().update("print.colourScheme", fileName, vscode.ConfigurationTarget.Global).then(() => {
            if (path !== styleCachePath) {
              let newCachePath = `${styleCachePath}/${fileName}`;
              fs.copyFile(p, newCachePath, err => {
                if (err) {
                  vscode.window.showErrorMessage(err.message);
                }
              });
            }
          }, (err) => {
            debugger;
          });
        } catch (err) {
          debugger;
        }
      }
    });
  });
  context.subscriptions.push(disposable);
  return { extendMarkdownIt(mdparam: any) { return md = mdparam; } };
}

const checkConfigurationChange = (e: vscode.ConfigurationChangeEvent) => {
  if (e.affectsConfiguration('print.editorContextMenuItemPosition')) {
    vscode.commands.executeCommand(
      "setContext", "ecmPrint",
      vscode.workspace.getConfiguration("print", null)
        .get('editorContextMenuItemPosition'));
  }
  if (e.affectsConfiguration('print.editorTitleMenuButton')) {
    vscode.commands.executeCommand(
      "setContext", "etmButton",
      vscode.workspace.getConfiguration("print", null)
        .get<boolean>('editorTitleMenuButton'));
  }
};

function getFileText(fname: string): string {
  // vscode.window.showInformationMessage(`vsc-print get ${fname}`);

  var text = fs.readFileSync(fname).toString();
  // strip BOM when present
  // vscode.window.showInformationMessage(`vsc-print got ${fname}`);
  return text.indexOf('\uFEFF') === 0 ? text.substring(1, text.length) : text;
}

async function getSourceCode(): Promise<string[]> {
  let sender = "NOT SET";
  let commandArgsFsPath = commandArgs ? commandArgs.fsPath : undefined;
  let editorFsPath = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri.fsPath : undefined;
  // if command and editor fsPath match, or no commandArgs at all use the 
  // in -memory document from the active editor
  let pathsMatch = editorFsPath === commandArgsFsPath;
  let noCommandArgs = typeof commandArgs === "undefined";
  sender = (pathsMatch || noCommandArgs) ? "ACTIVE TEXT EDITOR" : "FILE EXPLORER";
  if (!commandArgs) {
    commandArgs = { fsPath: commandArgsFsPath || editorFsPath };
  }
  let result = [];
  switch (sender) {
    case "ACTIVE TEXT EDITOR":
      if (vscode.window.activeTextEditor) {
        result.push(vscode.window.activeTextEditor.document.languageId);
        result.push(selection && !(selection.isEmpty || selection.isSingleLine) ?
          vscode.window.activeTextEditor.document.getText(new vscode.Range(selection.start, selection.end)).replace(/\s*$/, "") :
          vscode.window.activeTextEditor.document.getText());
      }
      break;
    case "FILE EXPLORER":
      try {
        let otd = await vscode.workspace.openTextDocument(commandArgs.fsPath);
        result.push(otd.languageId);
        result.push(otd.getText());
      } catch (error) {
        throw new Error(`Cannot access ${commandArgsFsPath}.\n${error.Message}`);
      }
      break;
  }
  return result;
}

const lineNumberCss = `
/* Line numbers */

table {
  border: none;
  border-collapse: collapse;
}
.line-number {
  border-right: thin solid silver;
  padding-right: 0.3em;
  text-align: right;
  vertical-align: top;
}
.line-text {
  margin-left: 0.7em;
  padding-bottom: {lineSpacing}em;
  white-space: pre-wrap;
}
`;

async function getRenderedSourceCode(): Promise<string> {
  let printConfig = vscode.workspace.getConfiguration("print", null);
  let printAndClose = printConfig.printAndClose ? " onload = \"window.print();\" onafterprint=\"window.close();\"" : "";
  let fsPath: string;
  fsPath = "NOT SET";
  if (commandArgs) {
    fsPath = commandArgs.fsPath;
  }
  else if (vscode.window.activeTextEditor) {
    fsPath = vscode.window.activeTextEditor.document.uri.fsPath;
  }
  if (printConfig.renderMarkdown && fsPath.toLowerCase().split('.').pop() === "md") {
    let markdownConfig = vscode.workspace.getConfiguration("markdown", null);
    let raw = fs.readFileSync(fsPath).toString();
    let content = md.render(raw);
    try {
      // 1 - prepend base local path to relative URLs
      let a = fsPath.replace(/\\/g, "/"); // forward slashes only, they work on all platforms
      let b = a.substring(0, a.lastIndexOf("/")); // clip file name
      let c = b.replace(/([a-z]):/i, "$1C/O/L/O/N"); // escape colon on Windows
      content = content.replace(/(img src=")(?!http[s]?)(?![a-z]:)([^"]+)/gi, `$1${c}/$2`);
      // 2 - escape colon in embedded file paths
      content = content.replace(/(img src="[a-z]):([^"]*)/gi, `$1C/O/L/O/N/$2`);
    } catch (error) {
      debugger;
    }
    let result = `<!DOCTYPE html><html><head><title>${fsPath}</title>
    <meta charset="utf-8"/>
    <style>
    html, body {
      font-family: ${markdownConfig.preview.fontFamily};
      font-size: ${markdownConfig.preview.fontSize}px;
      line-height: ${markdownConfig.preview.lineHeight}em;
    }
    img {
      max-width: 100%;
    }
    h1,h2,h3,h4,h5,h6 {
      page-break-after:avoid;
      page-break-inside:avoid;
    }
    </style>
    ${markdownConfig.styles.map((cssFilename: string) => `<link href="${cssFilename}" rel="stylesheet" />`).join("\n")}
    </head>
		<body${printAndClose}>${content}</body></html>`;
    return result;
  }
  let x = vscode.extensions.getExtension("pdconsec.vscode-print");
  if (!x) { throw new Error("Cannot resolve extension. Has the name changed? It is defined by the publisher and the extension name defined in package.json"); }
  let stylePath = `${x.extensionPath}/node_modules/highlight.js/styles`;
  let defaultCss = getFileText(`${stylePath}/default.css`);
  let swatchCss = getFileText(`${stylePath}/${printConfig.colourScheme}.css`);
  let sourceCode = await getSourceCode();
  let renderedCode = "";
  try {
    renderedCode = hljs.highlight(sourceCode[0], sourceCode[1]).value;
  }
  catch (err) {
    renderedCode = hljs.highlightAuto(sourceCode[1]).value;
  }
  var addLineNumbers = printConfig.lineNumbers === "on" || (printConfig.lineNumbers === "inherit" && vscode.window.activeTextEditor && (vscode.window.activeTextEditor.options.lineNumbers || 0) > 0);
  if (addLineNumbers) {
    var startLine = selection && !(selection.isEmpty || selection.isSingleLine) ? selection.start.line + 1 : 1;
    renderedCode = renderedCode
      .split("\n")
      .map((line, i) => `<tr><td class="line-number">${startLine + i}</td><td class="line-text">${line}</td></tr>`)
      .join("\n")
      .replace("\n</td>", "</td>")
      ;
  } else {
    renderedCode = renderedCode
      .split("\n")
      .map((line, i) => `<tr><td class="line-text">${line}</td></tr>`)
      .join("\n")
      .replace("\n</td>", "</td>")
      ;
  }
  let editorConfig = vscode.workspace.getConfiguration("editor", null);
  let html = `<html><head><title>${fsPath}</title><meta charset="utf-8"/><style>body{margin:0;padding:0;tab-size:${editorConfig.tabSize}}\n${defaultCss}\r${swatchCss}\n${lineNumberCss.replace("{lineSpacing}", (printConfig.lineSpacing - 1).toString())}\n.hljs { max-width:100%; width:100%; font-family: "${editorConfig.fontFamily}", monospace; font-size: ${printConfig.fontSize}; }\n</style></head><body${printAndClose}><table class="hljs">${renderedCode}</table></body></html>`;
  return html;
}

var server: http.Server | undefined;
var port: number;

function startWebserver(): Promise<void> {
  return new Promise(async (resolve, reject) => {
    // prepare to service an http request
    server = http.createServer(async (request, response) => {
      try {
        if (request.url) {
          if (request.url === "/") {
            response.setHeader("Content-Type", "text/html");
            let html = await getRenderedSourceCode();
            response.end(html);
          } else {
            let filePath: string = request.url.substr(1).replace(/C\/O\/L\/O\/N/g, ":");
            let cb = fs.statSync(filePath).size;
            let lastdotpos = request.url.lastIndexOf('.');
            let fileExt = request.url.substr(lastdotpos + 1);
            response.setHeader("Content-Type", `image/${fileExt}`);
            response.setHeader("Content-Length", cb);
            fs.createReadStream(filePath).pipe(response);
          }
        }
      } catch (error) {
        response.setHeader("Content-Type", "text/plain");
        response.end(error.stack);
      }
    });
    // report exceptions
    server.on("error", (err: any) => {
      if (err) {
        switch (err.code) {
          case "EACCES":
            vscode.window.showErrorMessage("ACCESS DENIED ESTABLISHING WEBSERVER");
            break;
          default:
            vscode.window.showErrorMessage(`UNEXPECTED ERROR: ${err.code}`);
        }
      }
    });
    server.on("listening", () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
    let printConfig = vscode.workspace.getConfiguration("print", null);
    server.listen();
  });
}

export function deactivate() {
  if (server) { server.close(); }
}