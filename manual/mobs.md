# Mobs

How 1.7.10 mobs notice, move and attack. Distances are in blocks, feet to feet.

## Noticing you

- Zombies, skeletons and creepers notice you only with line of sight, within 4 up or down, and within 40 for a zombie or 16 for the others. They give up after about 3 s without sight of you, or once you are past that range.
- Sneaking does not hide you from them. It cuts how far spiders and endermen notice you to 0.8 of their range.
- Spiders look for you only in darkness, within 16 and through walls. In light a spider seeks no target and drops the one it has at random.
- An enderman turns on you when you look at its head from within 64.

## Walls, fences and gaps

- Zombies, skeletons and creepers step up half a block and jump about 1.25.
- They never path over a fence, a wall or a closed fence gate, all 1.5 high. An open gate lets them through.
- Spiders climb any wall they touch.
- An enderman needs 3 clear blocks of height.
- Zombies break a door only on hard difficulty, and only some zombies try. On easy and normal they bang on it and crack it, and it holds.

## Creepers

- A creeper starts to swell within 3, stands still while it swells, and explodes after 1.5 s of swelling.
- Beyond 7 or out of its sight it stops swelling, and the fuse runs back down at the same pace instead of resetting. A corner, a door or a block placed between you stops the swell.
- A hit knocks it back but does not stop the fuse.
- Blast damage on normal by distance: 0 → 49, 2 → 27, 4 → 11, 6 → 1, none beyond 6. Easy halves it and adds 1, hard adds half. Blocks between you and the blast cut it.
- A sword block takes 49 to 25 before armor. Full diamond takes 49 to about 10.

## Zombies

- A zombie reaches about 1.4, in 3D. Two blocks above one you are out of its reach, and your sword (reach 3) still hits it.
- It hits for 3 on normal, 2.5 on easy and 4.5 on hard. A burning zombie with empty hands can set you on fire.

## Skeletons

- A skeleton within 15 that sees you stands still and shoots, one arrow every 1 to 3 s, slower when farther. It does not strafe or back off. Its first arrow comes one full interval after it notices you.
- Beyond 15 or out of its sight it walks toward you.

## Daylight

- Zombies and skeletons catch fire in daylight under open sky. A helmet takes the damage instead. Water and rain put the fire out, and baby zombies do not burn.
