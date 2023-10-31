node('build-slave') {
    try {
        String ANSI_GREEN = "\u001B[32m"
        String ANSI_NORMAL = "\u001B[0m"
        String ANSI_BOLD = "\u001B[1m"
        String ANSI_RED = "\u001B[31m"
        String ANSI_YELLOW = "\u001B[33m"

        ansiColor('xterm') {
                stage('Checkout') {
                    if (!env.hub_org) {
                        println(ANSI_BOLD + ANSI_RED + "Uh Oh! Please set a Jenkins environment variable named hub_org with value as registery/sunbidrded" + ANSI_NORMAL)
                        error 'Please resolve the errors and rerun..'
                    } else
                        println(ANSI_BOLD + ANSI_GREEN + "Found environment variable named hub_org with value as: " + hub_org + ANSI_NORMAL)
                }
                
                cleanWs()
                checkout scm
                commit_hash = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                build_tag = sh(script: "echo " + params.github_release_tag.split('/')[-1] + "_" + commit_hash + "_" + env.BUILD_NUMBER, returnStdout: true).trim()
                echo "build_tag: " + build_tag
		
		          stage('docker-pre-build') {
              sh '''
              pwd
              docker build -f ./Dockerfile.build -t $docker_pre_build .
              docker run --name=$docker_pre_build $docker_pre_build && docker cp $docker_pre_build:/usr/src/app/dist.zip .
              sleep 30
              docker rm -f $docker_pre_build
              docker rmi -f $docker_pre_build
              unzip -o dist.zip
                '''
              }


            stage('Build') {
                env.NODE_ENV = "build"
                print "Environment will be : ${env.NODE_ENV}"
                sh('chmod 777 build.sh')
                sh("bash -x build.sh ${build_tag} ${env.NODE_NAME} ${docker_server}")
            }

	      
               stage('ArchiveArtifacts') {
	       	   sh ("echo ${build_tag} > build_tag.txt")
                   archiveArtifacts "metadata.json"		     
                    archiveArtifacts "build_tag.txt" 
                    currentBuild.description = "${build_tag}"
                }
            
        }
    }
    catch (err) {
        currentBuild.result = "FAILURE"
        throw err
    }
   
}
