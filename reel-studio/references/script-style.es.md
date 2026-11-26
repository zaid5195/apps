# Series style guide: «¿Sabes por qué?» (Spanish edition)

This guide is sent to the LLM before every Spanish script. Edit it to change the voice of the whole Spanish series.

## The series
A faceless science-explainer reel in **Spanish**, vertical 9:16.
Each episode answers one curious "why / how" question about science, the body, nature or technology.
The tone is warm, curious and fast, like a friend who studied science telling you something amazing over a coffee.
Use **tú**, not usted. Keep it neutral: understandable in Spain and Latin America, without strong regional slang.

## Structure (always in this order)
1. **Hook**: one short sentence that stops the scroll. It is a surprising fact, a paradox or a "you do this every day" moment.
   - Example: «Tu corazón late unas cien mil veces al día… sin que lo pienses ni una vez.»
2. **The series question**: the exact phrase **«¿Sabes por qué?»** on its own line, straight after the hook.
3. **Explanation**: 2–5 very short lines with one idea per line. Name the real mechanism.
4. **One simple analogy**: compare it to something from daily life (el metro en hora punta, la batería del móvil, la cocina, el tráfico).
   Use only one analogy and keep it consistent.
5. **Recap**: one closing line that sums it up, starting with words like «O sea» / «En resumen» / «Así que».

## Language rules
- Use spoken Spanish: short sentences, contractions, no academic tone.
- Keep scientific terms accurate: célula, neurona, ADN, oxígeno, dopamina, enzima, virus, proteína, CO2.
- Use short lines of 4–10 words, one line per breath.
- Write numbers as digits (100, 37, 8). Units can be abbreviated (km, °C).
- Use correct opening punctuation: ¿…? and ¡…!
- Use no emojis, hashtags, stage directions, brackets or speaker names.
- Say nothing you can't support with a reliable source. Simplify, but don't distort.

## Length
- Target **about 2.8 spoken words per second** (10 s ≈ 28 words, 30 s ≈ 84 words, 60 s ≈ 168 words).
- A 10–20 s reel still keeps the hook, «¿Sabes por qué?», one analogy and the recap, just compressed.

## Output format (exactly)
```
TITLE: <short Spanish title, max 6 words>
SCRIPT:
<line 1: hook>
¿Sabes por qué?
<lines…>
<recap line>
SOURCES:
- <source 1: organisation / paper / textbook, with a URL if known>
- <source 2>
```
