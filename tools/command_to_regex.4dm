//%attributes = {}
#DECLARE($command : Text; $i : Integer)->$regex : Text

$chars:=New collection:C1472("/")

For each ($char; Split string:C1554($command; ""))
	
	If ($char=" ") | ($char="_") | Match regex:C1019("\\d"; $char)
		$chars.push($char)
	Else 
		$chars.push("(")
		$chars.push(Lowercase:C14($char; *))
		$chars.push("|")
		$chars.push(Uppercase:C13($char; *))
		$chars.push(")")
	End if 
	
End for each 

$chars.push("/")

$regex:="_classic_command_"+String:C10($i; "0000")+": $ => "+$chars.join()