Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\陳奕嘉\學測複習進度追蹤"
WshShell.Run "cmd /c npm start > server.log 2>&1", 0, False
