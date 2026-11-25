//%attributes = {"invisible":true}
// Error handler for generate_builtins_dump. Installed there with ON ERR CALL.
//
// Without it a failing command ends the run with a bare exit code and no
// output, which is indistinguishable from a crash of tool4d itself. Called with
// $1=1 on install, $1=2 on error.
var $signal : Integer

$signal:=$1

If ($signal=2)
	LOG EVENT(Into system standard outputs; "generate_builtins_dump: 4D error "+String(Error code)+" in "+Error method+": "+Error description; Error message)
End if 
