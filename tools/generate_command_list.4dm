//%attributes = {"invisible":true}
$commands:=New collection:C1472
$types:=New collection:C1472
$l:=New collection:C1472
For ($i; 1; 1818)
	$command:=Command name:C538($i)
	Case of 
		: ($i=948)  //begin sql
		: ($i=949)  //end sql
		: ($command="")
		: ($command="_4D@")
		: ($command="C_@") || ($command="ARRAY @")
			$command:=Uppercase:C13(Replace string:C233($command; " "; ""; *); *)
			$types.push("L\""+$command+"\"")
			$l.push(Length:C16($command))
			continue
		: ($command="4D")
		: ($command="ds")
		: ($command="cs")
		Else 
			$command:=Uppercase:C13(Replace string:C233($command; " "; ""; *); *)
			$commands.push("L\""+$command+"\"")
			$l.push(Length:C16($command))
	End case 
End for 

$max:=$l.max()

SET TEXT TO PASTEBOARD:C523($types.orderBy(ck descending:K85:8).combine($commands.orderBy(ck descending:K85:8)).join(",\r"))
