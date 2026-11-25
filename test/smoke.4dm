#DECLARE($name : Text; $count : Integer)->$label : Text

// Exercised by .github/workflows/regenerate-parser.yml: the regenerated
// src/parser.c must parse this with no ERROR or MISSING node. It is also the
// case builtins.h exists for -- multi-word commands and constants, which are
// indistinguishable from identifiers until the external scanner matches them.
ARRAY TEXT($items; 0)
$label:=String(Current date)+" "+$name
$items.push(New collection(1; 2))

If ($count>0)
	For ($i; 1; $count)
		$items.push(C_Text($i))
	End for
Else
	$label:="none"
End if

Case of
	: ($count=1)
		$label:="one"
	Else
		$label:=String($count)
End case

Begin SQL
	SELECT * FROM [Table_1] WHERE [Field_1] = 'x'
End SQL

Try
	CLEAR VARIABLE($items)
Catch
	ALERT("failed")
End try
