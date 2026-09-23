# Changelog

## 0.14.9

- La première remontée `coreinfo` ou WTS d’un agent qui vient de se connecter est maintenant considérée comme une nouvelle arrivée et applique immédiatement la règle aux utilisateurs présents.
- L’amorçage global au redémarrage de MeshCentral reste silencieux afin de ne pas choisir arbitrairement entre des sessions qui étaient déjà ouvertes avant le redémarrage.
- Un poste découvert plus de trente secondes après le chargement du plugin bénéficie du même contrôle, même si son événement `nodeconnect` n’a pas été reçu.

## 0.14.8

- Un nouvel utilisateur découvert par l’inventaire WTS déclenche désormais la règle même si l’agent n’a pas transmis l’événement Security 4624.
- Ce rattrapage couvre notamment les postes inclus dans le total des agents en ligne mais absents du compteur vert « Journal Windows ».
- Les watchers absents ou arrêtés sont désormais relancés automatiquement, avec un intervalle minimal d’une minute entre deux essais.
- Chaque poste affiché dans un conflit dispose d’un bouton « Afficher la demande ici » permettant de relancer immédiatement le choix sur le poste où l’utilisateur souhaite continuer.
- Une relance manuelle remplace proprement une ancienne demande restée en attente pour le même compte et le même poste.

## 0.14.7

- Correction de la course `child exited with code: 0/undefined` du composant `message-box` de MeshAgent, qui pouvait perdre un clic Oui ou Non pourtant effectué.
- Le dialogue est désormais exécuté dans un `ScriptContainer` rattaché à la session Windows et conserve son processus 1,5 seconde après l’envoi de la réponse.
- Le serveur attend également brièvement une éventuelle réponse arrivée en même temps que la notification de fin du processus.
- Les détails d’erreur identiques ne sont plus répétés deux fois dans « Dernières décisions ».

## 0.14.6

- Nettoyage automatique et strictement ciblé des anciens fichiers temporaires `maintctl_*.ps1`, résultats JSON/TXT et archives ZIP abandonnés depuis plus d’une heure.
- Le nettoyage est exécuté au premier appel du module puis au maximum toutes les dix minutes ; il ne touche ni les fichiers d’autres logiciels ni les journaux nommés d’après les postes.
- Un script PowerShell temporaire est maintenant supprimé immédiatement si son processus ne peut pas être démarré ou signale une erreur.
- `maintctl-agent.log` reste limité par rotation et l’unique `maintctl-logon-watch.ps1` est conservé pendant la surveillance des connexions Windows.

## 0.14.5

- La boîte Oui/Non est maintenant créée par le module natif `message-box` de MeshAgent directement dans l’identifiant de session Windows concerné.
- Le dialogue ne dépend plus d’un PowerShell exécuté par le service, qui pouvait rester invisible bien que le script ait été correctement généré.
- Les réponses Oui et Non remontent directement depuis le processus interactif MeshAgent ; les accents utilisent l’API Unicode Windows sans conversion intermédiaire.
- Un délai de sécurité ferme la nouvelle session si le processus interactif ne peut pas créer ou retourner le dialogue.

## 0.14.4

- Un nouvel événement Windows `4624` déclenche désormais le contrôle même si l’inventaire `coreinfo` considère déjà l’utilisateur présent sur le poste.
- Cette situation se produisait notamment après un essai incomplet ou après le redémarrage du plugin avec deux sessions déjà recensées : aucune commande de dialogue n’était alors envoyée.
- Une déduplication de dix secondes empêche toutefois `coreinfo` et le journal Windows d’afficher deux dialogues pour la même ouverture de session.

## 0.14.3

- Les choix Oui/Non sont maintenant écrits dans un fichier de résultat ASCII surveillé toutes les 250 ms par MeshAgent ; l’action ne dépend plus de la remontée de stdout ni de l’événement `exit` du PowerShell.
- Le choix Oui déclenche systématiquement la fermeture du poste distant, tandis que Non déclenche une commande séparée de fermeture immédiate sur la nouvelle session.
- Les caractères français du dialogue sont déclarés avec des séquences Unicode ASCII dans le module agent avant leur encodage Base64, ce qui empêche MeshAgent de supprimer `é`, `à` ou `ê` au chargement du code.

## 0.14.2

- Le mode proposition attend maintenant que la nouvelle session WTS soit réellement `Active` ou `Connected` avant d’afficher la question ; l’événement `4624` arrivait parfois trop tôt pour que Windows accepte le dialogue.
- Le délai de sécurité côté serveur tient compte de cette attente et ne ferme plus la session pendant que la boîte de dialogue est encore utilisable.
- Suppression du BOM PowerShell ajouté en 0.14.1, incompatible avec certaines écritures de fichiers du runtime MeshAgent.
- Les textes Unicode sont transmis sous forme Base64 UTF-8 puis reconstruits par PowerShell : les accents restent corrects sans dépendre de l’encodage du fichier temporaire.
- Les erreurs du dialogue sont maintenant écrites dans `C:\\Windows\\Temp\\maintctl-agent.log` et visibles dans les dernières décisions du plugin.

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
