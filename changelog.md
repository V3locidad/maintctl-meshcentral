# Changelog

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
