# Changelog

## 0.14.1

- Le choix « Oui » du mode proposition ferme maintenant immédiatement la session distante, sans afficher un second dialogue de dix secondes sur l’ancien poste.
- Si la fermeture distante échoue, la nouvelle session est fermée afin de ne jamais laisser deux sessions actives malgré la règle.
- Le résultat `IDYES` du dialogue est relu dans toute la sortie PowerShell pour rester fiable même lorsque stdout est fragmenté.
- Les scripts PowerShell temporaires sont écrits en UTF-8 avec BOM : les accents français sont désormais affichés correctement.
- Le texte du dialogue a été reformulé et l’interface indique explicitement lequel des deux modes est réellement enregistré.

## 0.14.0

- Ajout d’une surveillance temps réel du journal de sécurité Windows sur chaque MeshAgent.
- Les événements `4624` des connexions interactives locales, mises en cache et RDP sont transmis immédiatement au serveur, sans attendre la prochaine remontée `coreinfo`.
- En mode « Refuser », le deuxième logon est fermé dès sa détection, normalement pendant l’écran « Bienvenue », sans attendre `explorer.exe` ni afficher un dialogue bloquant.
- Le premier poste réserve immédiatement le compte côté serveur ; une connexion presque simultanée sur un autre poste est donc identifiée comme la nouvelle session.
- Les événements `4634` et un inventaire WTS local libèrent rapidement la réservation à la fermeture de session.
- L’onglet Connexions indique combien d’agents surveillent effectivement le journal Windows.

## 0.13.2

- Le message et la fermeture de la nouvelle session sont maintenant exécutés dans une seule commande Windows.
- En mode « Refuser », le message disparaît automatiquement après cinq secondes puis la session est fermée, sans action obligatoire sur le bouton OK.
- La fermeture essaie successivement l’API WTS, `logoff.exe` et `rwinsta.exe` sur l’identifiant exact de la session qui a reçu le message.
- Les textes de la boîte Windows utilisent des caractères compatibles avec Windows PowerShell 5 afin d’éviter les accents mal affichés.

## 0.13.1

- Le mode « Refuser » ferme maintenant la nouvelle session directement depuis MeshAgent, sans dépendre d’un second aller-retour avec le serveur.
- Ajout de `logoff.exe` comme secours lorsque `WTSLogoffSession` est refusé par Windows.
- En mode proposition, un refus ou une expiration ferme également la nouvelle session directement sur le poste.
- Correction de l’onglet « Connexions » : les cartes ne sont plus compressées et la page défile sans que le tableau chevauche les dernières décisions.

## 0.13.0

- Ajout d’un onglet « Connexions » pour autoriser ou bloquer l’utilisation simultanée d’un même compte Windows sur plusieurs postes.
- Le refus indique à l’utilisateur la salle et le poste où son autre session est ouverte, puis ferme la nouvelle session.
- Un mode alternatif propose de fermer la ou les sessions distantes afin de continuer sur le nouveau poste.
- Ajout de la liste des sessions connues, des conflits actuels, des dernières décisions et des comptes exclus de la règle.
- Les paramètres sont conservés dans `maintctl-config.json`.
