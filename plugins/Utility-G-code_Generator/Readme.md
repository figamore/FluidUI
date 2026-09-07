J'ai crée ce script pour faciliter l'utilisation de ma CNC.
Biensûr il existe des outils CAO et calcul de parcours d'outil qui font tout celà mais c'est assez lourd d'utilisation, chaque modification implique de revenir  la source et de reproduire le Gcode.
Cet outil intégré en plugin permet dans FigUI sur FluidNC permet tout en restant dans l'interface de créer et modifier instantanéement le gcode.
Par exemple un surfaçage : on positionne la broche, en quelque clics on peut lancer le surfaçage et le corriger immédiatement (sans aucun transfer de fichiers.
J'ai souvent besoin de faire des perçages  (comme tout le monde ;o) on peut alors lancer une matrice X/Y, prévisualiser, et lancer..
Un perçage par détourage, c'est très simple ici.
Un trou oblong, idem on défini X Y la largeur  , taille de fraise...
Un rayonage sur le plan X/Y peut être assez lourd via la CAO, ici on defini le coin, le sens, le rayon...
en Fin programmer un filetage est extrèment lourd, tu choisi Vis ou ecrou, le pas la profondeur de passe, le nombre de fillets, c'est immédiat..
NB un filletage est aussi une bonne façon de réaliser un trou borgne, car le mouvement sera hélicoïdal avec un tour plat à fond de fillet..

Pour lancer le plugin, depuis l'interface FigUI (plugin), la fenêtre s'ouvre directement sur les derniers paramètres utilisés ou les valeurs pas défaut.
les modifications des champs s'exécutent instantanément (le g-code ainsi que le visuel), [Ouvrir dans le viewer] pour basculer sur FigUI, le retour vers le plugin reprendra les dernières valeurs.


I created this script to make my CNC easier to use.
Of course there are CAD and toolpath calculation tools that do all this but it is quite cumbersome to use, each modification involves returning to the source and reproducing the Gcode.
This tool integrated into a plugin allows in FigUI on FluidNC to instantly create and modify the gcode while remaining in the interface.
For example surfacing: we position the spindle, in a few clicks we can start the surfacing and correct it immediately (without any file transfer)
I often need to do drilling (like everyone else;o) we can then run an X/Y matrix, preview, and run.
Contour drilling is very simple here.
An oblong hole, ditto we define XY the width, cutter size...
corner radiusing in the X/Y plane can be quite heavy via CAD, here we define the corner, the direction, the radius...
finally, programming a thread is extremely heavy, you choose Screw or nut, the pitch, the depth of cut, the number of threads, it's immediate.
NB threading is also a good way to make a blind hole, because the movement will be helical with a flat turn at the bottom of the thread.

To launch the plugin, from the FigUI interface (plugin), the window opens directly on the last parameters used or the default values.
field modifications are executed instantly (the g-code as well as the visual), [Open in viewer] to switch to FigUI, returning to the plugin will return to the last values.

https://github.com/Franky464/Utility-G-code_Generator_FigUI_Plugin  
