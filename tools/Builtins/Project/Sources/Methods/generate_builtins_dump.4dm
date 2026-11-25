//%attributes = {"invisible":true}

// Headless twin of tools/generate_command_list.4dm + tools/generate_constant_list.4dm.
//
// The two manual tools stop at the pasteboard; CI has no pasteboard, so this
// method writes the same two name lists to a JSON file and quits. Content
// selection below is kept deliberately identical to those tools:
//
//   * commands come from Command name(i), minus the SQL bounds, the wildcard
//     stubs (_4D@, C_@, ARRAY @) and the bare aliases (4D, ds, cs);
//   * constants come from 4D_ConstantsEN.xlf, which ships inside the tool4d
//     build (tool4d.app/Contents/Resources on macOS, Resources/ on Linux and
//     Windows).
//
// Differs on purpose: names keep their embedded spaces (the pasteboard tools
// strip them for the regex generator) because builtins.h stores `ARRAY INTEGER`
// and `Attribute published SQL` verbatim, and duplicates are dropped, because
// the XLF repeats a few entries across theme groups.
//
// --user-param = {"dump": "<path to write>", "xlf": "<path to 4D_ConstantsEN.xlf>"}
// The caller passes the XLF path because it already knows where it unpacked
// tool4d. Discovering it from inside the run needs `Application file`, which
// answers with an empty path under tool4d -- Folder(""; fk platform path) then
// raises "A valid posix path was expected" before anything can be logged. A
// bare path is accepted as --user-param too, but then there is no XLF to read
// and the run stops with that as the reason.

var $param : Text

$param:=""
Get database parameter(User param value; $param)

If ($param="")
	LOG EVENT(Into system standard outputs; "generate_builtins_dump: pass --user-param with {\"dump\": ..., \"xlf\": ...}"; Error message)
	QUIT 4D(1)
End if 

// A command that fails must name itself: an empty exit code says nothing about
// which of the calls below tool4d did not like.
ON ERR CALL("dump_on_err")

var $config : Object
var $dumpPath : Text
var $xlfPath : Text

$config:=New object
$dumpPath:=""
$xlfPath:=""

If ($param[[1]]="{")
	$config:=JSON Parse($param)
	$dumpPath:=String($config.dump)
	$xlfPath:=String($config.xlf)
Else 
	$dumpPath:=$param
End if 

LOG EVENT(Into system standard outputs; "generate_builtins_dump: dumping to "+$dumpPath+" xlf="+$xlfPath; Information message)

If ($dumpPath="")
	LOG EVENT(Into system standard outputs; "generate_builtins_dump: no output path in --user-param"; Error message)
	QUIT 4D(1)
End if 

// ---------------------------------------------------------------- constants

var $constants : Collection
var $file : 4D.File
var $found : Boolean
var $constant : Text
var $i : Integer

$constants:=New collection
$found:=False

If ($xlfPath="")
	LOG EVENT(Into system standard outputs; "generate_builtins_dump: --user-param has no \"xlf\"; point it at 4D_ConstantsEN.xlf inside the tool4d build"; Error message)
	QUIT 4D(1)
End if 

$file:=File($xlfPath)
$found:=$file.exists

If (Not($found))
	LOG EVENT(Into system standard outputs; "generate_builtins_dump: no such file: "+$xlfPath; Error message)
	QUIT 4D(1)
End if 

LOG EVENT(Into system standard outputs; "generate_builtins_dump: constants from "+$file.platformPath; Information message)

// DOM refs stay untagged: the commands return Longint refs in older builds and
// Text refs in current ones, and a wrong annotation is a compile error.
$dom:=DOM Parse XML source($file.platformPath)

If (OK#1)
	LOG EVENT(Into system standard outputs; "generate_builtins_dump: cannot parse "+$file.platformPath; Error message)
	QUIT 4D(1)
End if 

ARRAY TEXT($nodes; 0)

$node:=DOM Find XML element($dom; "/xliff/file/body/group[@restype='x-4DK#']/trans-unit/target"; $nodes)

For ($i; 1; Size of array($nodes))
	DOM GET XML ELEMENT VALUE($nodes{$i}; $constant)
	If ($constant#"")
		If ($constants.indexOf($constant)=-1)
			$constants.push($constant)
		End if 
	End if 
End for 

DOM CLOSE XML($dom)

If ($constants.length=0)
	LOG EVENT(Into system standard outputs; "generate_builtins_dump: no constants found in "+$file.platformPath; Error message)
	QUIT 4D(1)
End if 

// ---------------------------------------------------------------- commands

var $commands : Collection
var $command : Text

$commands:=New collection

// The manual tool hardcodes 1818 (the count for 21 R3/R4). Scanning past the
// end of the command range yields "", so a generous bound keeps this correct
// for later releases without a code change. 4D command ids are stable, hence
// the explicit exclusions by id.
For ($i; 1; 4000)
	$command:=Command name($i)
	Case of 
		: ($i=948)  //begin sql
		: ($i=949)  //end sql
		: ($command="")
		: ($command="_4D@")
		: ($command="C_@") || ($command="ARRAY @")
		: ($command="4D")
		: ($command="ds")
		: ($command="cs")
		Else 
			If ($commands.indexOf($command)=-1)
				$commands.push($command)
			End if 
	End case 
End for 

// Command name() reports the two declaration families as single wildcards --
// "ARRAY @" and "C_@" -- so their members have to be named here. Leaving them
// out would drop ARRAY INTEGER, C_TEXT and 24 others that 4D code is written
// with, which is exactly what the table is for. This is the one place the
// list is not read from 4D; it is 26 stable names, checked against the
// previous table.
For Each ($command; New collection("ARRAY BLOB"; "ARRAY BOOLEAN"; "ARRAY DATE"; "ARRAY INTEGER"; "ARRAY LONGINT"; "ARRAY OBJECT"; "ARRAY PICTURE"; "ARRAY POINTER"; "ARRAY REAL"; "ARRAY TEXT"; "ARRAY TIME"; "ARRAY TO COLLECTION"; "ARRAY TO LIST"; "ARRAY TO SELECTION"; "C_BLOB"; "C_BOOLEAN"; "C_COLLECTION"; "C_DATE"; "C_LONGINT"; "C_OBJECT"; "C_PICTURE"; "C_POINTER"; "C_REAL"; "C_TEXT"; "C_TIME"; "C_VARIANT"))
	If ($commands.indexOf($command)=-1)
		$commands.push($command)
	End if 
End for each 

If ($commands.length=0)
	LOG EVENT(Into system standard outputs; "generate_builtins_dump: Command name() returned nothing"; Error message)
	QUIT 4D(1)
End if 

// ---------------------------------------------------------------- output

var $json : Object
var $out : 4D.File

$json:=New object
$json.version:=Application version
$json.commands:=$commands
$json.constants:=$constants

$out:=File($dumpPath)

TEXT TO DOCUMENT($out.platformPath; JSON Stringify($json; *))

LOG EVENT(Into system standard outputs; "generate_builtins_dump: wrote "+$out.platformPath+" commands="+String($commands.length)+" constants="+String($constants.length); Information message)

QUIT 4D(0)
