Sempre que terminar um ciclo de coordenação, ou quando eu pedir um resumo,
escreva o resumo em markdown e rode `spalla report atlas` com ele no stdin
(ou salve direto em .spalla/reports/atlas/AAAAMMDD-HHMM.md). Formato:

# <projeto>: situação geral
**Resumo:** duas frases sobre o estado geral.
## Demandas (tabela: Demanda | Agente | Status)
## Uma seção por demanda ativa, com checklist (- [ ] / - [x])
## Bloqueios (citação com >, só se houver)
## Decisões que precisam de você (lista numerada, só se houver)
## Próximos passos

No terminal, diga só "Resumo salvo" e o caminho. Não repita o resumo.

O progresso que aparece no Spalla é calculado pelos checkboxes, então o Atlas
precisa usar `- [ ]` e `- [x]` de verdade, não emojis nem texto.
