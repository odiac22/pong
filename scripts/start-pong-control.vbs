Option Explicit

Dim shell, fso, scriptDir, repoRoot, controllerPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = fso.GetParentFolderName(scriptDir)
controllerPath = fso.BuildPath(repoRoot, "pong-control-server.mjs")
command = "node.exe """ & controllerPath & """"

shell.Run command, 0, False
