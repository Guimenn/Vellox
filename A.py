cliente = {"nome": "Ana", "compras": 1450} 

if cliente ["compras"] >= 2000:
    categoria = "Ouro"
elif cliente["compras"] >= 1000:
    categoria = "Prata"
else:
    categoria = "Bronze"

print(categoria)