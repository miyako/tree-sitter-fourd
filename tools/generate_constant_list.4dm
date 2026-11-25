//%attributes = {}
$folder:=Folder:C1567(Application file:C491; fk platform path:K87:2)
$file:=$folder.file("Contents/Resources/en.lproj/4D_ConstantsEN.xlf")

$dom:=DOM Parse XML source:C719($file.platformPath)

$constants:=New collection:C1472


$l:=New collection:C1472

If (OK=1)
	var $constant : Text
	ARRAY TEXT:C222($nodes; 0)
	$node:=DOM Find XML element:C864($dom; "/xliff/file/body/group[@restype='x-4DK#']/trans-unit/target"; $nodes)
	For ($i; 1; Size of array:C274($nodes))
		$node:=$nodes{$i}
		DOM GET XML ELEMENT VALUE:C731($node; $constant)
		$constant:=Uppercase:C13(Replace string:C233($constant; " "; ""; *); *)
		If ($constant#"")
			//If ($char>="A") & ($char<="H")
			$constants.push("L\""+$constant+"\"")
			$l.push(Length:C16($constant))
			//End if 
		End if 
	End for 
	DOM CLOSE XML:C722($dom)
End if 

$max:=$l.max()

SET TEXT TO PASTEBOARD:C523($constants.orderBy(ck descending:K85:8).join(",\r"))
