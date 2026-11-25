$code:=Get text from pasteboard:C524

ARRAY LONGINT:C221($pos; 0)
ARRAY LONGINT:C221($len; 0)

$i:=1
$lines:=New collection:C1472
While (Match regex:C1019("(\\s*\\(+.+)( \\[\\d+, \\d+\\] - \\[\\d+, \\d+\\])(\\)*)"; $code; $i; $pos; $len))
	
	$lines.push(Substring:C12($code; $pos{1}; $len{1})+Substring:C12($code; $pos{3}; $len{3}))
	
	$i:=$pos{1}+$len{1}
	
End while 

SET TEXT TO PASTEBOARD:C523($lines.join("\r"))
