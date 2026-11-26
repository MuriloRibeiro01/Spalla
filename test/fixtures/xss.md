# Aceite: conteúdo hostil (usar: spalla report atlas test/fixtures/xss.md; a aba não pode mudar de título e nada pode virar link ou tag)

**Resumo:** teste de segurança do renderizador.

<img src=x onerror="document.title='PWNED-img'">

<script>document.title='PWNED-script'</script>

[link perigoso](javascript:document.title='PWNED-link') e [link bom](https://example.com) e [data](data:text/html,x).

## Lista

- [x] feito
- [ ] pendente
- [ ] outro pendente
